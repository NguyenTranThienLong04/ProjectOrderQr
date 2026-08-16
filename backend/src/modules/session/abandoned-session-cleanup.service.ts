import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { TableStatus } from '../../common/enums/table-status.enum';
import { AppGateway } from '../../gateway/app.gateway';
import { Order, OrderDocument } from '../order/order.schema';
import { Table, TableDocument } from '../table/table.schema';
import { Session, SessionDocument } from './session.schema';

const DEFAULT_EMPTY_SESSION_TIMEOUT_MINUTES = 10;
const MAX_CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 100;

@Injectable()
export class AbandonedSessionCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AbandonedSessionCleanupService.name);
  private readonly timeoutMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private scheduledCleanup?: Promise<number>;
  private cleanupInProgress = false;

  constructor(
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => AppGateway))
    private readonly appGateway: AppGateway,
  ) {
    const configuredMinutes = Number(
      this.configService.get<string>('EMPTY_SESSION_TIMEOUT_MINUTES') ??
        DEFAULT_EMPTY_SESSION_TIMEOUT_MINUTES,
    );
    if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
      throw new Error('EMPTY_SESSION_TIMEOUT_MINUTES phải là số dương');
    }
    this.timeoutMs = configuredMinutes * 60_000;
  }

  onApplicationBootstrap(): void {
    const intervalMs = Math.min(this.timeoutMs, MAX_CLEANUP_INTERVAL_MS);
    this.cleanupTimer = setInterval(() => {
      this.startScheduledCleanup('định kỳ');
    }, intervalMs);
    this.cleanupTimer.unref();

    // Clear sessions already stale when the process starts; later runs are periodic.
    this.startScheduledCleanup('khi khởi động');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    try {
      await this.scheduledCleanup;
    } catch {
      // The scheduled path already logged the original error.
    }
  }

  private startScheduledCleanup(context: string): void {
    if (this.scheduledCleanup) return;
    const cleanup = this.cleanupAbandonedSessions();
    this.scheduledCleanup = cleanup;
    void cleanup
      .catch((error: unknown) => {
        this.logger.error(`Không thể cleanup Session ${context}`, error);
      })
      .finally(() => {
        if (this.scheduledCleanup === cleanup)
          this.scheduledCleanup = undefined;
      });
  }

  /**
   * Reads only candidates here. The transaction below repeats every predicate,
   * including zero lifetime Orders, before it changes Session or Table state.
   */
  async cleanupAbandonedSessions(now = new Date()): Promise<number> {
    if (this.cleanupInProgress) return 0;
    this.cleanupInProgress = true;
    try {
      const cutoff = new Date(now.getTime() - this.timeoutMs);
      const staleActivity = this.staleActivityFilter(cutoff);
      const candidates = await this.sessionModel
        .find({ status: SessionStatus.ACTIVE, ...staleActivity })
        .select('_id')
        .limit(CLEANUP_BATCH_SIZE)
        .lean()
        .exec();
      const expiredSessionIds: string[] = [];

      for (const candidate of candidates) {
        try {
          if (await this.expireCandidate(candidate._id, cutoff, now)) {
            expiredSessionIds.push(candidate._id.toString());
          }
        } catch (error) {
          // A conflicting cart/order write can abort this attempt. The next pass
          // sees its fresh activity or Order and leaves that Session active.
          this.logger.warn(
            `Bỏ qua cleanup Session ${candidate._id.toString()} sau conflict/error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (expiredSessionIds.length > 0) {
        for (const sessionId of expiredSessionIds) {
          this.appGateway.emit(`session:${sessionId}`, 'session:expired', {
            sessionId,
          });
        }
        this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
      }
      return expiredSessionIds.length;
    } finally {
      this.cleanupInProgress = false;
    }
  }

  private staleActivityFilter(cutoff: Date): Record<string, unknown> {
    return {
      $or: [
        { lastActivityAt: { $lte: cutoff } },
        // Backward compatibility for active documents created before this field.
        {
          lastActivityAt: { $exists: false },
          startedAt: { $lte: cutoff },
        },
      ],
    };
  }

  private async expireCandidate(
    sessionId: Types.ObjectId,
    cutoff: Date,
    endedAt: Date,
  ): Promise<boolean> {
    const mongoSession = await this.connection.startSession();
    let expired = false;
    try {
      await mongoSession.withTransaction(async () => {
        const staleActivity = this.staleActivityFilter(cutoff);
        const session = await this.sessionModel
          .findOne({
            _id: sessionId,
            status: SessionStatus.ACTIVE,
            ...staleActivity,
          })
          .session(mongoSession)
          .exec();
        if (!session) return;

        // Any Order at any status permanently opts the Session out of this timeout.
        const hasEverOrdered = await this.orderModel
          .exists({ sessionId: session._id })
          .session(mongoSession)
          .exec();
        if (hasEverOrdered) return;

        const closed = await this.sessionModel
          .updateOne(
            {
              _id: session._id,
              status: SessionStatus.ACTIVE,
              ...staleActivity,
            },
            {
              $set: {
                status: SessionStatus.EXPIRED,
                endedAt,
                cart: [],
              },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (closed.modifiedCount !== 1) return;

        await this.tableModel
          .updateMany(
            { currentSessionId: session._id },
            {
              $set: {
                status: TableStatus.AVAILABLE,
                currentSessionId: null,
                groupedWithTableIds: [],
              },
            },
            { session: mongoSession },
          )
          .exec();
        expired = true;
      });
      return expired;
    } finally {
      await mongoSession.endSession();
    }
  }
}
