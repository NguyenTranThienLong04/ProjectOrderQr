import { readOrderNoteReceipt } from '../../common/order-note-receipt';
import type { OrderNoteAnalysis } from '../../common/schemas/order-note-analysis.schema';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Dish, DishDocument } from '../dish/dish.schema';
import { Table, TableDocument } from '../table/table.schema';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { Session, SessionDocument } from './session.schema';
import { Order, OrderDocument } from '../order/order.schema';
import { OrderStatus } from '../../common/enums/order-status.enum';
import {
  PaymentIntent,
  PaymentIntentDocument,
} from '../vnpay/payment-intent.schema';
import { lifecycleTransaction } from './lifecycle-transaction';

export const MAX_CART_ITEM_NOTE_LENGTH = 250;

export interface CartItemResponse {
  cartItemId: string;
  dishId: string;
  dishName: string;
  unitPrice: number;
  quantity: number;
  note?: string;
  aiNoteAnalysis?: OrderNoteAnalysis;
}

export interface TableOperationCandidate {
  tableId: string;
  tableIds: string[];
  tableCodes: string[];
  displayName: string;
  status: TableStatus;
  sessionId?: string;
  groupKey: string;
}

export interface UnmergeOperationCandidate {
  kind: 'session' | 'table_group';
  childSessionId?: string;
  rootSessionId?: string;
  tableId?: string;
  tableIds: string[];
  displayName: string;
  mergedAt?: Date;
}

@Injectable()
export class SessionService {
  constructor(
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
    @InjectModel(Table.name) private readonly tableModel: Model<TableDocument>,
    @InjectModel(Dish.name) private readonly dishModel: Model<DishDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(PaymentIntent.name)
    private readonly paymentIntentModel: Model<PaymentIntentDocument>,
  ) {}

  private toCartResponse(session: SessionDocument) {
    return {
      sessionId: session.id,
      tableId: session.tableId.toString(),
      tableIds: (session.tableIds?.length
        ? session.tableIds
        : [session.tableId]
      ).map((id) => id.toString()),
      version: session.version,
      cart: session.cart.map((item) => ({
        cartItemId: item._id.toString(),
        dishId: item.dishId.toString(),
        dishName: item.dishName,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        note: item.note,
        aiNoteAnalysis: item.aiNoteAnalysis,
      })),
    };
  }

  private cartSnapshotsEqual(
    left: Session['cart'],
    right: Session['cart'],
  ): boolean {
    const summarize = (items: Session['cart']) => {
      const summary = new Map<string, string>();
      for (const item of items) {
        const key = this.cartItemIdentityKey(item.dishId, item.note);
        summary.set(
          key,
          JSON.stringify({
            dishName: item.dishName,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
          }),
        );
      }
      return [...summary.entries()].sort(([a], [b]) => a.localeCompare(b));
    };
    return JSON.stringify(summarize(left)) === JSON.stringify(summarize(right));
  }

  /** Rooms that own an Order now, while Order.tableId remains its audit origin. */
  async getRealtimeOrderRooms(sessionId: string, sourceTableId: string) {
    const session = Types.ObjectId.isValid(sessionId)
      ? await this.sessionModel
          .findById(sessionId)
          .select('tableId tableIds')
          .exec()
      : null;
    const physicalTableIds = session
      ? (session.tableIds?.length ? session.tableIds : [session.tableId]).map(
          (id) => id.toString(),
        )
      : [sourceTableId];
    return [
      `session:${sessionId}`,
      ...new Set([...physicalTableIds, sourceTableId]).values(),
    ].map((roomOrId, index) => (index === 0 ? roomOrId : `table:${roomOrId}`));
  }

  /** Backend-owned choices prevent the waiter UI from inferring merge state from OCCUPIED. */
  async getTableOperationOptions() {
    const tables = await this.tableModel.find().sort({ tableCode: 1 }).exec();
    const tableById = new Map(tables.map((table) => [table.id, table]));
    const activeSessionIds = [
      ...new Set(
        tables
          .map((table) => table.currentSessionId?.toString())
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const activeSessions = await this.sessionModel
      .find({
        _id: { $in: activeSessionIds.map((id) => new Types.ObjectId(id)) },
        status: SessionStatus.ACTIVE,
      })
      .exec();
    const sessionById = new Map(
      activeSessions.map((session) => [session.id, session]),
    );
    const tableCodes = (ids: Types.ObjectId[]) =>
      ids
        .map((id) => tableById.get(id.toString())?.tableCode)
        .filter((code): code is string => Boolean(code))
        .sort((a, b) => a.localeCompare(b));
    const candidateByGroup = new Map<string, TableOperationCandidate>();

    for (const table of tables) {
      const session = table.currentSessionId
        ? sessionById.get(table.currentSessionId.toString())
        : undefined;
      if (session) {
        if (table.status !== TableStatus.OCCUPIED) continue;
        const ids = session.tableIds?.length
          ? session.tableIds
          : [session.tableId];
        const codes = tableCodes(ids);
        const groupKey = `session:${session.id}`;
        if (!candidateByGroup.has(groupKey)) {
          candidateByGroup.set(groupKey, {
            tableId: session.tableId.toString(),
            tableIds: ids.map((id) => id.toString()),
            tableCodes: codes,
            displayName: codes.join(' + '),
            status: table.status,
            sessionId: session.id,
            groupKey,
          });
        }
        continue;
      }
      // A pre-session grouped table is already part of a merge unit and must
      // never be offered as an independent candidate.
      if (
        table.currentSessionId ||
        table.status !== TableStatus.AVAILABLE ||
        table.groupedWithTableIds?.length
      ) {
        continue;
      }
      candidateByGroup.set(`table:${table.id}`, {
        tableId: table.id,
        tableIds: [table.id],
        tableCodes: [table.tableCode],
        displayName: table.tableCode,
        status: table.status,
        groupKey: `table:${table.id}`,
      });
    }

    const mergeCandidates = [...candidateByGroup.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    const moveSources = mergeCandidates.filter(
      (candidate) => candidate.sessionId && candidate.tableIds.length === 1,
    );
    const moveDestinations = mergeCandidates.filter(
      (candidate) => !candidate.sessionId && candidate.tableIds.length === 1,
    );

    const directChildIds = [
      ...new Set(
        activeSessions.flatMap((session) =>
          (session.mergedFromSessionIds ?? []).map((id) => id.toString()),
        ),
      ),
    ];
    const children = directChildIds.length
      ? await this.sessionModel
          .find({
            _id: {
              $in: directChildIds.map((id) => new Types.ObjectId(id)),
            },
            status: SessionStatus.MERGED,
            mergedIntoSessionId: { $ne: null },
          })
          .exec()
      : [];
    const unmergeGroups: UnmergeOperationCandidate[] = children.flatMap(
      (child) => {
        if (
          !child.mergedIntoSessionId ||
          !child.mergedAt ||
          !child.preMergeTableIds?.length
        ) {
          return [];
        }
        const root = sessionById.get(child.mergedIntoSessionId.toString());
        if (!root) return [];
        const rootIds = root.tableIds?.length ? root.tableIds : [root.tableId];
        const rootCodes = tableCodes(rootIds);
        const childCodes = tableCodes(child.preMergeTableIds);
        return [
          {
            childSessionId: child.id,
            kind: 'session' as const,
            rootSessionId: root.id,
            tableIds: child.preMergeTableIds.map((id) => id.toString()),
            displayName:
              childCodes.length === 1
                ? `Nhóm ${rootCodes.join(' + ')} · tách ${childCodes[0]}`
                : `Nhóm ${rootCodes.join(' + ')} · tách ${childCodes.join(' + ')}`,
            mergedAt: child.mergedAt,
          },
        ];
      },
    );

    const seenTableGroups = new Set<string>();
    for (const table of tables) {
      if (
        table.currentSessionId ||
        table.status !== TableStatus.AVAILABLE ||
        !table.groupedWithTableIds?.length
      ) {
        continue;
      }
      const ids = [
        ...new Set([
          table.id,
          ...table.groupedWithTableIds.map((id) => id.toString()),
        ]),
      ].sort();
      const groupKey = ids.join(':');
      if (seenTableGroups.has(groupKey)) continue;
      const members = ids
        .map((id) => tableById.get(id))
        .filter(
          (member): member is NonNullable<typeof member> =>
            member !== undefined,
        );
      const isSafeGroup =
        members.length === ids.length &&
        members.every(
          (member) =>
            !member.currentSessionId &&
            member.status === TableStatus.AVAILABLE &&
            ids.every(
              (id) =>
                id === member.id ||
                member.groupedWithTableIds.some(
                  (groupedId) => groupedId.toString() === id,
                ),
            ),
        );
      if (!isSafeGroup) continue;
      seenTableGroups.add(groupKey);
      const codes = ids
        .map((id) => tableById.get(id)?.tableCode)
        .filter((code): code is string => Boolean(code))
        .sort((a, b) => a.localeCompare(b));
      unmergeGroups.push({
        kind: 'table_group',
        tableId: table.id,
        tableIds: ids,
        displayName: `Nhóm ${codes.join(' + ')}`,
        mergedAt: table.groupedAt ?? undefined,
      });
    }

    return { moveSources, moveDestinations, mergeCandidates, unmergeGroups };
  }

  /** Claim the whole group or nothing, including races with move/merge/clear. */
  async getOrCreateActiveSession(tableId: string) {
    const session = await lifecycleTransaction(
      this.connection,
      async (mongoSession) => {
        const table = await this.tableModel
          .findById(tableId)
          .session(mongoSession)
          .exec();
        if (!table) throw new NotFoundException('Không tìm thấy bàn');
        if (table.currentSessionId) {
          const current = await this.sessionModel
            .findOneAndUpdate(
              {
                _id: table.currentSessionId,
                status: SessionStatus.ACTIVE,
                $or: [{ tableIds: table._id }, { tableId: table._id }],
              },
              { $set: { lastActivityAt: new Date() } },
              { returnDocument: 'after', session: mongoSession },
            )
            .exec();
          if (current) return current;
          throw new ConflictException(
            'Bàn đang trỏ tới phiên không còn hoạt động',
          );
        }
        // waiting_payment describes an active dining session; it is not a terminal
        // table state. Only reject inconsistent data where no active session can be
        // restored, rather than creating a duplicate session behind the stale state.
        if (table.status === TableStatus.WAITING_PAYMENT) {
          throw new BadRequestException(
            'Bàn đang chờ thanh toán nhưng phiên ăn không còn hoạt động',
          );
        }
        if (table.status !== TableStatus.AVAILABLE)
          throw new ConflictException('Bàn không khả dụng');

        const groupedIds = [
          ...new Set([
            table.id,
            ...(table.groupedWithTableIds ?? []).map((id) => id.toString()),
          ]),
        ].map((id) => new Types.ObjectId(id));
        const members = await this.tableModel
          .find({ _id: { $in: groupedIds } })
          .session(mongoSession)
          .exec();
        if (
          members.length !== groupedIds.length ||
          members.some(
            (member) =>
              member.currentSessionId ||
              member.status !== TableStatus.AVAILABLE ||
              member.groupedWithTableIds.length !== groupedIds.length - 1 ||
              !groupedIds.every(
                (id) =>
                  id.equals(member._id) ||
                  member.groupedWithTableIds.some((other) => other.equals(id)),
              ),
          )
        )
          throw new ConflictException(
            'Nhóm bàn vừa thay đổi, vui lòng tải lại',
          );
        const candidate = await new this.sessionModel({
          tableId: table._id,
          tableIds: groupedIds,
        }).save({ session: mongoSession });
        const claimedTable = await this.tableModel
          .updateMany(
            {
              _id: { $in: groupedIds },
              currentSessionId: null,
              status: TableStatus.AVAILABLE,
            },
            {
              $set: {
                currentSessionId: candidate._id,
                status: TableStatus.OCCUPIED,
                groupedWithTableIds: [],
                groupRootTableId: null,
                groupedAt: null,
              },
              $inc: { __v: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (claimedTable.modifiedCount !== groupedIds.length)
          throw new ConflictException('Không thể nhận toàn bộ nhóm bàn');
        return candidate;
      },
    );
    return this.toResumableSessionResponse(session);
  }

  /** Backend-owned preview subtotal using the current active cart and live Dish prices. */
  async getActiveCartSubtotal(tableId: string): Promise<number> {
    const table = await this.tableModel.findById(tableId).exec();
    if (!table?.currentSessionId)
      throw new NotFoundException('Không tìm thấy phiên ăn đang hoạt động');
    const session = await this.sessionModel
      .findOne({ _id: table.currentSessionId, status: SessionStatus.ACTIVE })
      .exec();
    if (!session) throw new NotFoundException('Phiên ăn không còn hoạt động');
    if (!session.cart.length)
      throw new BadRequestException('Giỏ hàng đang trống');
    const dishIds = [
      ...new Set(session.cart.map((item) => item.dishId.toString())),
    ];
    const dishes = await this.dishModel
      .find({ _id: { $in: dishIds }, isAvailable: true })
      .exec();
    if (dishes.length !== dishIds.length) {
      throw new BadRequestException(
        'Một hoặc nhiều món không tồn tại hoặc đã hết món',
      );
    }
    const prices = new Map(dishes.map((dish) => [dish.id, dish.price]));
    return session.cart.reduce(
      (total, item) =>
        total + (prices.get(item.dishId.toString()) ?? 0) * item.quantity,
      0,
    );
  }

  private async toResumableSessionResponse(session: SessionDocument) {
    const currentOrder = await this.orderModel
      .findOne({
        sessionId: session._id,
        status: { $nin: [OrderStatus.PAID, OrderStatus.CANCELLED] },
      })
      .sort({ createdAt: -1 })
      .select('status subtotalAmount discountAmount totalAmount promotionCode')
      .exec();
    return {
      ...this.toCartResponse(session),
      currentOrder: currentOrder
        ? {
            orderId: currentOrder.id,
            status: currentOrder.status,
            subtotalAmount: currentOrder.subtotalAmount,
            discountAmount: currentOrder.discountAmount,
            totalAmount: currentOrder.totalAmount,
            promotionCode: currentOrder.promotionCode,
          }
        : null,
    };
  }

  async getCart(sessionId: string) {
    const session = await this.sessionModel
      .findOne({ _id: sessionId, status: SessionStatus.ACTIVE })
      .exec();
    if (!session) throw new NotFoundException('Phiên ăn không còn hoạt động');
    return this.toCartResponse(session);
  }

  private async findAvailableDish(dishId: string): Promise<DishDocument> {
    const dish = await this.dishModel
      .findOne({ _id: dishId, isAvailable: true })
      .exec();
    if (!dish)
      throw new BadRequestException('Món không tồn tại hoặc đã hết món');
    return dish;
  }

  private normalizeCartItemNote(note?: string): string | undefined {
    if (note === undefined) return undefined;
    if (typeof note !== 'string') {
      throw new BadRequestException('Ghi chú món phải là chuỗi');
    }
    const normalized = note.trim();
    if (!normalized) return undefined;
    if (normalized.length > MAX_CART_ITEM_NOTE_LENGTH) {
      throw new BadRequestException(
        `Ghi chú món không được vượt quá ${MAX_CART_ITEM_NOTE_LENGTH} ký tự`,
      );
    }
    return normalized;
  }

  private cartItemIdentity(
    dishId: Types.ObjectId,
    note?: string,
  ): Record<string, unknown> {
    if (note) return { dishId, note };
    // Legacy cart rows may omit note, store null, or contain whitespace only.
    return {
      dishId,
      $or: [{ note: { $exists: false } }, { note: null }, { note: /^\s*$/ }],
    };
  }

  private cartItemIdentityKey(dishId: Types.ObjectId, note?: string): string {
    return `${dishId.toString()}\u001f${note?.trim() ?? ''}`;
  }

  /**
   * Every mutation is a MongoDB atomic update. In particular, $inc applies to
   * the current stored quantity, so concurrent “+1” requests compose (+2)
   * instead of overwriting one another as a read-modify-write implementation would.
   */
  async addToCart(
    sessionId: string,
    dishId: string,
    quantity: number,
    note?: string,
    analysisToken?: unknown,
    confirmedByCustomer?: unknown,
    authorizedTableId?: string,
  ) {
    if (
      !Types.ObjectId.isValid(dishId) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 50
    ) {
      throw new BadRequestException('Dữ liệu thêm giỏ hàng không hợp lệ');
    }
    const normalizedNote = this.normalizeCartItemNote(note);
    const dish = await this.findAvailableDish(dishId);
    const aiNoteAnalysis =
      confirmedByCustomer === true
        ? readOrderNoteReceipt(
            analysisToken,
            sessionId,
            dishId,
            normalizedNote ?? '',
            dish.availableModifiers ?? [],
          )
        : undefined;
    const objectDishId = new Types.ObjectId(dishId);
    const itemIdentity = this.cartItemIdentity(objectDishId, normalizedNote);
    let session = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: sessionId,
          status: SessionStatus.ACTIVE,
          ...(authorizedTableId
            ? { tableIds: new Types.ObjectId(authorizedTableId) }
            : {}),
          cart: { $elemMatch: itemIdentity },
        },
        {
          $inc: { 'cart.$.quantity': quantity, version: 1 },
          $set: {
            lastActivityAt: new Date(),
            ...(aiNoteAnalysis
              ? { 'cart.$.aiNoteAnalysis': aiNoteAnalysis }
              : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!session) {
      session = await this.sessionModel
        .findOneAndUpdate(
          {
            _id: sessionId,
            status: SessionStatus.ACTIVE,
            ...(authorizedTableId
              ? { tableIds: new Types.ObjectId(authorizedTableId) }
              : {}),
            cart: { $not: { $elemMatch: itemIdentity } },
          },
          {
            $push: {
              cart: {
                dishId: objectDishId,
                dishName: dish.name,
                unitPrice: dish.price,
                quantity,
                note: normalizedNote,
                aiNoteAnalysis,
              },
            },
            $inc: { version: 1 },
            $set: { lastActivityAt: new Date() },
          },
          { new: true },
        )
        .exec();
    }
    // Another client can insert first between the two operations; retry as $inc.
    if (!session) {
      session = await this.sessionModel
        .findOneAndUpdate(
          {
            _id: sessionId,
            status: SessionStatus.ACTIVE,
            ...(authorizedTableId
              ? { tableIds: new Types.ObjectId(authorizedTableId) }
              : {}),
            cart: { $elemMatch: itemIdentity },
          },
          {
            $inc: { 'cart.$.quantity': quantity, version: 1 },
            $set: {
              lastActivityAt: new Date(),
              ...(aiNoteAnalysis
                ? { 'cart.$.aiNoteAnalysis': aiNoteAnalysis }
                : {}),
            },
          },
          { new: true },
        )
        .exec();
    }
    if (!session) throw new NotFoundException('Phiên ăn không còn hoạt động');
    return this.toCartResponse(session);
  }

  async updateCartQuantity(
    sessionId: string,
    dishId: string,
    quantity: number,
    cartItemId?: string,
    authorizedTableId?: string,
  ) {
    if (
      !Types.ObjectId.isValid(dishId) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 50
    ) {
      throw new BadRequestException('Số lượng không hợp lệ');
    }
    if (cartItemId && !Types.ObjectId.isValid(cartItemId)) {
      throw new BadRequestException('Mã dòng giỏ hàng không hợp lệ');
    }
    const itemIdentity = cartItemId
      ? {
          _id: new Types.ObjectId(cartItemId),
          dishId: new Types.ObjectId(dishId),
        }
      : { dishId: new Types.ObjectId(dishId) };
    const session = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: sessionId,
          status: SessionStatus.ACTIVE,
          ...(authorizedTableId
            ? { tableIds: new Types.ObjectId(authorizedTableId) }
            : {}),
          cart: { $elemMatch: itemIdentity },
        },
        {
          $set: {
            'cart.$.quantity': quantity,
            lastActivityAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { new: true },
      )
      .exec();
    if (!session)
      throw new NotFoundException(
        'Không tìm thấy món trong giỏ hoặc phiên đã đóng',
      );
    return this.toCartResponse(session);
  }

  async removeFromCart(
    sessionId: string,
    dishId: string,
    cartItemId?: string,
    authorizedTableId?: string,
  ) {
    if (!Types.ObjectId.isValid(dishId))
      throw new BadRequestException('Mã món không hợp lệ');
    if (cartItemId && !Types.ObjectId.isValid(cartItemId)) {
      throw new BadRequestException('Mã dòng giỏ hàng không hợp lệ');
    }
    const itemIdentity = cartItemId
      ? {
          _id: new Types.ObjectId(cartItemId),
          dishId: new Types.ObjectId(dishId),
        }
      : { dishId: new Types.ObjectId(dishId) };
    const session = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: sessionId,
          status: SessionStatus.ACTIVE,
          ...(authorizedTableId
            ? { tableIds: new Types.ObjectId(authorizedTableId) }
            : {}),
          cart: { $elemMatch: itemIdentity },
        },
        {
          $pull: { cart: itemIdentity },
          $inc: { version: 1 },
          $set: { lastActivityAt: new Date() },
        },
        { new: true },
      )
      .exec();
    if (!session)
      throw new NotFoundException(
        'Không tìm thấy món trong giỏ hoặc phiên đã đóng',
      );
    return this.toCartResponse(session);
  }

  async consumeCartForOrder(
    tableId: string,
    sessionId: string,
    cartVersion: number,
    mongoSession: ClientSession,
  ) {
    const session = await this.sessionModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(sessionId),
          version: cartVersion,
          tableIds: new Types.ObjectId(tableId),
          status: SessionStatus.ACTIVE,
          'cart.0': { $exists: true },
        },
        {
          $set: { cart: [], lastActivityAt: new Date() },
          $inc: { version: 1 },
        },
        { new: false, session: mongoSession },
      )
      .exec();
    if (!session)
      throw new BadRequestException(
        'Giỏ hàng đã thay đổi, đang trống hoặc phiên ăn không còn hoạt động. Vui lòng tải lại giỏ hàng',
      );
    return session;
  }

  /** Move an active single-table session to a different table.
   * Atomically releases the source and claims an ungrouped AVAILABLE table,
   * preserving OCCUPIED/WAITING_PAYMENT and the original financial references.
   */
  async moveSessionToTable(sessionId: string, newTableId: string) {
    if (
      !Types.ObjectId.isValid(sessionId) ||
      !Types.ObjectId.isValid(newTableId)
    ) {
      throw new BadRequestException('Mã không hợp lệ');
    }
    return lifecycleTransaction(this.connection, async (mongoSession) => {
      const session = await this.sessionModel
        .findOne({ _id: sessionId, status: SessionStatus.ACTIVE })
        .session(mongoSession)
        .exec();
      if (!session)
        throw new ConflictException(
          'Phiên ăn không tồn tại hoặc không còn hoạt động',
        );
      if ((session.tableIds?.length ?? 1) > 1)
        throw new BadRequestException(
          'Phiên đang ghép nhiều bàn; hãy tách bàn trước khi chuyển',
        );

      const newTable = await this.tableModel
        .findById(newTableId)
        .session(mongoSession)
        .exec();
      if (!newTable) throw new NotFoundException('Bàn đích không tồn tại');
      if (
        newTable.status !== TableStatus.AVAILABLE ||
        newTable.currentSessionId ||
        newTable.groupedWithTableIds?.length ||
        newTable.groupRootTableId
      ) {
        throw new ConflictException('Bàn đích không khả dụng');
      }
      await this.assertTableOwnership(session, mongoSession);
      const released = await this.tableModel
        .findOneAndUpdate(
          { _id: session.tableId, currentSessionId: session._id },
          {
            $set: { currentSessionId: null, status: TableStatus.AVAILABLE },
            $inc: { __v: 1 },
          },
          { returnDocument: 'before', session: mongoSession },
        )
        .exec();
      if (!released) throw new ConflictException('Bàn nguồn vừa thay đổi');

      // Claim new table atomically if still available
      const claimed = await this.tableModel
        .findOneAndUpdate(
          {
            _id: newTable._id,
            currentSessionId: null,
            status: TableStatus.AVAILABLE,
            groupedWithTableIds: { $size: 0 },
          },
          {
            $set: { currentSessionId: session._id, status: released.status },
            $inc: { __v: 1 },
          },
          { returnDocument: 'after', session: mongoSession },
        )
        .exec();
      if (!claimed)
        throw new ConflictException(
          'Không thể đổi sang bàn đích, vui lòng thử lại',
        );

      const moved = await this.sessionModel
        .updateOne(
          {
            _id: session._id,
            status: SessionStatus.ACTIVE,
            version: session.version,
          },
          {
            $set: { tableId: claimed._id, tableIds: [claimed._id] },
            $inc: { version: 1 },
          },
          { session: mongoSession },
        )
        .exec();
      if (moved.modifiedCount !== 1)
        throw new ConflictException('Phiên vừa thay đổi');

      return { sessionId: session._id.toString() };
    });
  }

  private async assertTableOwnership(
    session: SessionDocument,
    mongoSession: ClientSession,
  ) {
    const ids = session.tableIds?.length ? session.tableIds : [session.tableId];
    const tables = await this.tableModel
      .find({ currentSessionId: session._id })
      .session(mongoSession)
      .exec();
    if (
      tables.length !== ids.length ||
      !ids.some((id) => id.equals(session.tableId)) ||
      tables.some(
        (table) =>
          !ids.some((id) => id.equals(table._id)) ||
          ![TableStatus.OCCUPIED, TableStatus.WAITING_PAYMENT].includes(
            table.status,
          ),
      )
    )
      throw new ConflictException('Liên kết phiên và bàn không còn khớp');
  }

  private async assertNoPaymentHistory(
    sessionIds: Types.ObjectId[],
    mongoSession: ClientSession,
  ) {
    const orders = await this.orderModel
      .find({ sessionId: { $in: sessionIds } })
      .session(mongoSession)
      .exec();
    // Shares the Order write fence used by checkout and payment confirmation.
    // Checking PaymentIntent alone would leave a snapshot-isolation race.
    if (orders.length)
      await this.orderModel
        .updateMany(
          { _id: { $in: orders.map((order) => order._id) } },
          { $inc: { __v: 1 } },
          { session: mongoSession },
        )
        .exec();
    const history = await this.paymentIntentModel
      .exists({
        $or: [
          { sessionId: { $in: sessionIds } },
          { coveredOrderIds: { $in: orders.map((order) => order._id) } },
        ],
      })
      .session(mongoSession)
      .exec();
    if (history || orders.some((order) => order.status === OrderStatus.PAID))
      throw new ConflictException(
        'Không thể ghép/tách phiên đã có lịch sử checkout hoặc thanh toán',
      );
    return orders;
  }

  /** @deprecated Use mergeTables so the server, not the UI, chooses the business case. */
  async mergeSessions(sourceSessionId: string, targetSessionId: string) {
    if (
      !Types.ObjectId.isValid(sourceSessionId) ||
      !Types.ObjectId.isValid(targetSessionId)
    ) {
      throw new BadRequestException('Mã không hợp lệ');
    }
    if (sourceSessionId === targetSessionId)
      throw new BadRequestException('Không thể ghép một phiên với chính nó');

    const [source, target] = await Promise.all([
      this.sessionModel.findById(sourceSessionId).exec(),
      this.sessionModel.findById(targetSessionId).exec(),
    ]);
    if (!source)
      throw new NotFoundException(
        'Phiên nguồn không tồn tại hoặc không còn hoạt động',
      );
    if (!target)
      throw new NotFoundException(
        'Phiên đích không tồn tại hoặc không còn hoạt động',
      );

    return this.mergeTables(
      source.tableId.toString(),
      target.tableId.toString(),
      { source: sourceSessionId, target: targetSessionId },
    );
  }

  /** One authoritative merge flow. A transaction prevents duplicate merge/lost cart updates. */
  async mergeTables(
    sourceTableId: string,
    targetTableId: string,
    expectedSessions?: { source: string; target: string },
  ) {
    if (
      !Types.ObjectId.isValid(sourceTableId) ||
      !Types.ObjectId.isValid(targetTableId)
    )
      throw new BadRequestException('Mã bàn không hợp lệ');
    if (sourceTableId === targetTableId)
      throw new BadRequestException('Không thể ghép một bàn với chính nó');
    let result: {
      case: 'grouped' | 'joined' | 'merged';
      rootSessionId?: string;
      sourceSessionId?: string;
    };
    await lifecycleTransaction(
      this.connection,
      async (mongoSession: ClientSession) => {
        // The MongoDB driver forbids parallel operations on a ClientSession
        // while it has an active transaction.
        const sourceTable = await this.tableModel
          .findById(sourceTableId)
          .session(mongoSession)
          .exec();
        const targetTable = await this.tableModel
          .findById(targetTableId)
          .session(mongoSession)
          .exec();
        if (!sourceTable || !targetTable)
          throw new NotFoundException('Không tìm thấy một trong hai bàn');
        if (
          sourceTable.status === TableStatus.WAITING_PAYMENT ||
          targetTable.status === TableStatus.WAITING_PAYMENT
        )
          throw new BadRequestException(
            'Không thể ghép bàn đang chờ thanh toán',
          );
        const source = sourceTable.currentSessionId
          ? await this.sessionModel
              .findOne({
                _id: sourceTable.currentSessionId,
                status: SessionStatus.ACTIVE,
              })
              .session(mongoSession)
              .exec()
          : null;
        const target = targetTable.currentSessionId
          ? await this.sessionModel
              .findOne({
                _id: targetTable.currentSessionId,
                status: SessionStatus.ACTIVE,
              })
              .session(mongoSession)
              .exec()
          : null;
        if (
          expectedSessions &&
          (source?.id !== expectedSessions.source ||
            target?.id !== expectedSessions.target)
        )
          throw new ConflictException(
            'Phiên đã chuyển bàn hoặc đóng, vui lòng tải lại',
          );
        if (
          (sourceTable.currentSessionId && !source) ||
          (targetTable.currentSessionId && !target)
        ) {
          throw new BadRequestException(
            'Bàn đang trỏ tới phiên không hoạt động; cần kiểm tra lifecycle trước khi ghép',
          );
        }
        if (
          (!source && sourceTable.status !== TableStatus.AVAILABLE) ||
          (!target && targetTable.status !== TableStatus.AVAILABLE)
        ) {
          throw new BadRequestException(
            'Chỉ có thể ghép bàn trống đúng lifecycle hoặc bàn có phiên active',
          );
        }
        if (
          (source && sourceTable.status !== TableStatus.OCCUPIED) ||
          (target && targetTable.status !== TableStatus.OCCUPIED)
        ) {
          throw new BadRequestException(
            'Chỉ có thể ghép phiên active khi bàn đang ở trạng thái occupied',
          );
        }
        if (
          (!source && sourceTable.groupedWithTableIds?.length) ||
          (!target && targetTable.groupedWithTableIds?.length)
        ) {
          throw new BadRequestException(
            'Bàn đã thuộc một nhóm ghép và không thể được chọn như bàn độc lập',
          );
        }
        if (source && !source.tableId.equals(sourceTable._id)) {
          throw new BadRequestException(
            'Bàn nguồn là member của nhóm ghép; hãy chọn đúng nhóm thay vì bàn độc lập',
          );
        }
        if (target && !target.tableId.equals(targetTable._id)) {
          throw new BadRequestException(
            'Bàn chính là member của nhóm ghép; hãy chọn đúng nhóm thay vì bàn độc lập',
          );
        }
        for (const active of [source, target]) {
          if (active) await this.assertTableOwnership(active, mongoSession);
        }
        const orders = await this.assertNoPaymentHistory(
          [source?._id, target?._id].filter((id): id is Types.ObjectId => !!id),
          mongoSession,
        );
        if (!source && !target) {
          const groupedAt = new Date();
          const groupedSource = await this.tableModel
            .updateOne(
              { _id: sourceTable._id, currentSessionId: null },
              {
                $set: {
                  groupedWithTableIds: [targetTable._id],
                  groupRootTableId: targetTable._id,
                  groupedAt,
                },
                $inc: { __v: 1 },
              },
              { session: mongoSession },
            )
            .exec();
          const groupedTarget = await this.tableModel
            .updateOne(
              { _id: targetTable._id, currentSessionId: null },
              {
                $set: {
                  groupedWithTableIds: [sourceTable._id],
                  groupRootTableId: targetTable._id,
                  groupedAt,
                },
                $inc: { __v: 1 },
              },
              { session: mongoSession },
            )
            .exec();
          if (
            groupedSource.modifiedCount !== 1 ||
            groupedTarget.modifiedCount !== 1
          )
            throw new ConflictException('Bàn vừa thay đổi');
          result = { case: 'grouped' };
          return;
        }
        if (!source || !target) {
          const active = source ?? target!;
          const addedTable = source ? targetTable : sourceTable;
          const ids = [
            ...new Set([
              ...(active.tableIds?.length
                ? active.tableIds
                : [active.tableId]
              ).map((id) => id.toString()),
              addedTable.id,
            ]),
          ].map((id) => new Types.ObjectId(id));
          const joined = await this.sessionModel
            .updateOne(
              {
                _id: active._id,
                status: SessionStatus.ACTIVE,
                version: active.version,
              },
              { $set: { tableIds: ids }, $inc: { version: 1 } },
              { session: mongoSession },
            )
            .exec();
          if (joined.modifiedCount !== 1)
            throw new ConflictException(
              'Phiên đang thay đổi, vui lòng thử lại',
            );
          const joinedTables = await this.tableModel
            .updateMany(
              {
                _id: { $in: ids },
                $or: [
                  { currentSessionId: active._id },
                  {
                    _id: addedTable._id,
                    currentSessionId: null,
                    status: TableStatus.AVAILABLE,
                  },
                ],
              },
              {
                $set: {
                  currentSessionId: active._id,
                  status: TableStatus.OCCUPIED,
                  groupedWithTableIds: [],
                  groupRootTableId: null,
                  groupedAt: null,
                },
                $inc: { __v: 1 },
              },
              { session: mongoSession },
            )
            .exec();
          if (joinedTables.modifiedCount !== ids.length)
            throw new ConflictException('Bàn vừa thay đổi');
          result = { case: 'joined', rootSessionId: active.id };
          return;
        }
        if (source.id === target.id)
          throw new BadRequestException('Hai bàn đã thuộc cùng một phiên ăn');
        const mergedMap = new Map<
          string,
          {
            _id: Types.ObjectId;
            dishId: Types.ObjectId;
            dishName: string;
            unitPrice: number;
            quantity: number;
            note?: string;
            aiNoteAnalysis?: OrderNoteAnalysis;
            addedAt: Date;
          }
        >();
        const pushItem = (item: Session['cart'][number]) => {
          const normalizedNote = this.normalizeCartItemNote(item.note);
          const key = this.cartItemIdentityKey(item.dishId, normalizedNote);
          const old = mergedMap.get(key);
          if (old) {
            old.quantity += item.quantity;
            old.aiNoteAnalysis ??= item.aiNoteAnalysis;
          } else
            mergedMap.set(key, {
              _id: item._id,
              dishId: item.dishId,
              dishName: item.dishName,
              unitPrice: item.unitPrice,
              quantity: item.quantity,
              note: normalizedNote,
              aiNoteAnalysis: item.aiNoteAnalysis,
              addedAt: item.addedAt,
            });
        };
        target.cart.forEach(pushItem);
        source.cart.forEach(pushItem);
        const sourceTables = source.tableIds?.length
          ? source.tableIds
          : [source.tableId];
        const targetTables = target.tableIds?.length
          ? target.tableIds
          : [target.tableId];
        const allTableIds = [
          ...new Set(
            [...targetTables, ...sourceTables].map((id) => id.toString()),
          ),
        ].map((id) => new Types.ObjectId(id));
        const at = new Date();
        const descendants = await this.sessionModel
          .find({
            mergedIntoSessionId: source._id,
            status: SessionStatus.MERGED,
          })
          .session(mongoSession)
          .exec();
        const mergedTarget = await this.sessionModel
          .updateOne(
            {
              _id: target._id,
              status: SessionStatus.ACTIVE,
              version: target.version,
            },
            {
              $set: {
                cart: [...mergedMap.values()],
                tableIds: allTableIds,
              },
              $addToSet: { mergedFromSessionIds: source._id },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (mergedTarget.modifiedCount !== 1)
          throw new ConflictException(
            'Phiên đích vừa thay đổi, vui lòng thử lại',
          );
        const mark = await this.sessionModel
          .updateOne(
            {
              _id: source._id,
              status: SessionStatus.ACTIVE,
              version: source.version,
            },
            {
              $set: {
                status: SessionStatus.MERGED,
                mergedIntoSessionId: target._id,
                mergedAt: at,
                preMergeCart: source.cart,
                postMergeRootCart: [...mergedMap.values()],
                preMergeTableIds: sourceTables,
                preMergeOrderIds: orders
                  .filter((order) => order.sessionId.equals(source._id))
                  .map((order) => order._id),
                preMergeDescendantSessionIds: descendants.map(
                  (child) => child._id,
                ),
              },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (mark.modifiedCount !== 1)
          throw new ConflictException(
            'Phiên nguồn vừa thay đổi, vui lòng thử lại',
          );
        // Preserve the existing direct-to-active-root lookup convention.
        const reparented = await this.sessionModel
          .updateMany(
            {
              _id: { $in: descendants.map((child) => child._id) },
              mergedIntoSessionId: source._id,
              status: SessionStatus.MERGED,
            },
            { $set: { mergedIntoSessionId: target._id }, $inc: { version: 1 } },
            { session: mongoSession },
          )
          .exec();
        if (reparented.modifiedCount !== descendants.length)
          throw new ConflictException('Liên kết nhóm con vừa thay đổi');
        await this.orderModel
          .updateMany(
            { sessionId: source._id },
            {
              $set: { sessionId: target._id },
            },
            { session: mongoSession },
          )
          .exec();
        const mergedTables = await this.tableModel
          .updateMany(
            {
              _id: { $in: allTableIds },
              currentSessionId: { $in: [source._id, target._id] },
            },
            {
              $set: {
                currentSessionId: target._id,
                status: TableStatus.OCCUPIED,
                groupedWithTableIds: [],
                groupRootTableId: null,
                groupedAt: null,
              },
              $inc: { __v: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (mergedTables.modifiedCount !== allTableIds.length)
          throw new ConflictException('Bàn vừa thay đổi');
        result = {
          case: 'merged',
          rootSessionId: target.id,
          sourceSessionId: source.id,
        };
      },
    );
    return result!;
  }

  async unmergeSession(childSessionId?: string, tableId?: string) {
    if (!childSessionId && !tableId)
      throw new BadRequestException('Cần chọn phiên hoặc bàn cần tách');
    if (childSessionId && !Types.ObjectId.isValid(childSessionId))
      throw new BadRequestException('Mã phiên không hợp lệ');
    if (tableId && !Types.ObjectId.isValid(tableId))
      throw new BadRequestException('Mã bàn không hợp lệ');
    let restoredChildSessionId = childSessionId;
    let rootSessionId: string | undefined;
    let restoredTableIds: string[] = [];
    let ungroupedTableIds: string[] | undefined;
    await lifecycleTransaction(
      this.connection,
      async (mongoSession: ClientSession) => {
        if (tableId) {
          const selectedTable = await this.tableModel
            .findById(tableId)
            .session(mongoSession)
            .exec();
          if (
            selectedTable &&
            !selectedTable.currentSessionId &&
            selectedTable.status === TableStatus.AVAILABLE &&
            selectedTable.groupedWithTableIds?.length
          ) {
            const groupIds = [
              ...new Set([
                selectedTable.id,
                ...selectedTable.groupedWithTableIds.map((id) => id.toString()),
              ]),
            ];
            const members = await this.tableModel
              .find({
                _id: {
                  $in: groupIds.map((id) => new Types.ObjectId(id)),
                },
                currentSessionId: null,
                status: TableStatus.AVAILABLE,
              })
              .session(mongoSession)
              .exec();
            const symmetric =
              members.length === groupIds.length &&
              members.every((member) =>
                groupIds.every(
                  (id) =>
                    id === member.id ||
                    member.groupedWithTableIds.some(
                      (groupedId) => groupedId.toString() === id,
                    ),
                ),
              );
            if (!symmetric) {
              throw new BadRequestException(
                'Metadata nhóm bàn không đồng nhất; không thể tách tự động',
              );
            }
            const ungrouped = await this.tableModel
              .updateMany(
                {
                  _id: {
                    $in: groupIds.map((id) => new Types.ObjectId(id)),
                  },
                  currentSessionId: null,
                  status: TableStatus.AVAILABLE,
                },
                {
                  $set: {
                    groupedWithTableIds: [],
                    groupRootTableId: null,
                    groupedAt: null,
                  },
                  $inc: { __v: 1 },
                },
                { session: mongoSession },
              )
              .exec();
            if (ungrouped.modifiedCount !== groupIds.length) {
              throw new ConflictException(
                'Nhóm bàn vừa thay đổi; vui lòng tải lại và thử lại',
              );
            }
            ungroupedTableIds = groupIds;
            return;
          }
        }
        const childQuery = childSessionId
          ? { _id: childSessionId, status: SessionStatus.MERGED }
          : {
              status: SessionStatus.MERGED,
              preMergeTableIds: new Types.ObjectId(tableId!),
            };
        const child = await this.sessionModel
          .findOne(childQuery)
          .session(mongoSession)
          .exec();
        if (
          !child?.mergedIntoSessionId ||
          !child.mergedAt ||
          !child.preMergeTableIds?.length
        )
          throw new BadRequestException(
            'Phiên gộp này không có dữ liệu audit để tách tự động',
          );
        if (
          tableId &&
          !child.preMergeTableIds.some((id) =>
            id.equals(new Types.ObjectId(tableId)),
          )
        ) {
          throw new BadRequestException(
            'Bàn được chọn không thuộc phiên đã gộp này',
          );
        }
        if (tableId && child.preMergeTableIds.length !== 1) {
          throw new BadRequestException(
            'Không thể tách một bàn từ phiên nguồn nhiều bàn vì cart không có lịch sử theo từng bàn; cần xử lý thủ công',
          );
        }
        restoredChildSessionId = child.id;
        const root = await this.sessionModel
          .findOne({
            _id: child.mergedIntoSessionId,
            status: SessionStatus.ACTIVE,
          })
          .session(mongoSession)
          .exec();
        if (!root)
          throw new BadRequestException(
            'Phiên gốc không còn hoạt động; cần xử lý thủ công',
          );
        if (
          !(root.mergedFromSessionIds ?? []).some((id) => id.equals(child._id))
        ) {
          throw new BadRequestException(
            'Phiên được chọn không phải nhóm ghép trực tiếp hiện tại; hãy tách theo thứ tự ghép gần nhất',
          );
        }
        rootSessionId = root.id;
        await this.assertTableOwnership(root, mongoSession);
        await this.assertNoPaymentHistory([root._id, child._id], mongoSession);
        restoredTableIds = child.preMergeTableIds.map((id) => id.toString());
        const laterOrder = await this.orderModel
          .exists({ sessionId: root._id, createdAt: { $gt: child.mergedAt } })
          .session(mongoSession);
        if (laterOrder)
          throw new BadRequestException(
            'Không thể tách bàn vì nhóm đã phát sinh đơn hàng chung sau khi ghép.',
          );
        if (!child.postMergeRootCart) {
          throw new BadRequestException(
            'Không thể tách tự động vì audit cũ chưa có snapshot giỏ hàng chung; cần xử lý thủ công',
          );
        }
        if (!child.preMergeOrderIds || !child.preMergeDescendantSessionIds) {
          throw new ConflictException(
            'Audit cũ chưa có snapshot đơn hàng/phiên con; không thể tách tự động',
          );
        }
        if (!this.cartSnapshotsEqual(root.cart, child.postMergeRootCart)) {
          throw new BadRequestException(
            'Không thể tách bàn vì giỏ hàng chung đã thay đổi sau khi ghép.',
          );
        }
        const subtract = new Map<string, number>();
        for (const item of child.preMergeCart) {
          const key = this.cartItemIdentityKey(item.dishId, item.note);
          subtract.set(key, (subtract.get(key) ?? 0) + item.quantity);
        }
        const rootCart = root.cart.flatMap((item) => {
          const key = this.cartItemIdentityKey(item.dishId, item.note);
          const quantityToSubtract = Math.min(
            item.quantity,
            subtract.get(key) ?? 0,
          );
          subtract.set(key, (subtract.get(key) ?? 0) - quantityToSubtract);
          const quantity = item.quantity - quantityToSubtract;
          return quantity > 0
            ? [
                {
                  _id: item._id,
                  dishId: item.dishId,
                  dishName: item.dishName,
                  unitPrice: item.unitPrice,
                  note: item.note,
                  aiNoteAnalysis: item.aiNoteAnalysis,
                  addedAt: item.addedAt,
                  quantity,
                },
              ]
            : [];
        });
        const rootTableIds = (root.tableIds ?? []).filter(
          (id) =>
            !child.preMergeTableIds.some((childTableId) =>
              childTableId.equals(id),
            ),
        );
        if (
          !rootTableIds.length ||
          !rootTableIds.some((id) => id.equals(root.tableId)) ||
          !child.preMergeTableIds.every((id) =>
            root.tableIds.some((owned) => owned.equals(id)),
          )
        )
          throw new ConflictException('Liên kết bàn của nhóm đã thay đổi');
        const restoredRoot = await this.sessionModel
          .updateOne(
            {
              _id: root._id,
              status: SessionStatus.ACTIVE,
              version: root.version,
            },
            {
              $set: { cart: rootCart, tableIds: rootTableIds },
              $pull: { mergedFromSessionIds: child._id },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        const restoredChild = await this.sessionModel
          .updateOne(
            {
              _id: child._id,
              status: SessionStatus.MERGED,
              version: child.version,
              mergedIntoSessionId: root._id,
            },
            {
              $set: {
                status: SessionStatus.ACTIVE,
                tableId: child.preMergeTableIds[0],
                tableIds: child.preMergeTableIds,
                cart: child.preMergeCart,
                mergedIntoSessionId: null,
                mergedAt: null,
              },
              $inc: { version: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (
          restoredRoot.modifiedCount !== 1 ||
          restoredChild.modifiedCount !== 1
        )
          throw new ConflictException('Phiên vừa thay đổi');
        const restoredDescendants = await this.sessionModel
          .updateMany(
            {
              _id: { $in: child.preMergeDescendantSessionIds },
              mergedIntoSessionId: root._id,
              status: SessionStatus.MERGED,
            },
            { $set: { mergedIntoSessionId: child._id }, $inc: { version: 1 } },
            { session: mongoSession },
          )
          .exec();
        if (
          restoredDescendants.modifiedCount !==
          child.preMergeDescendantSessionIds.length
        )
          throw new ConflictException('Liên kết nhóm con vừa thay đổi');
        const restoredOrders = await this.orderModel
          .updateMany(
            {
              sessionId: root._id,
              _id: { $in: child.preMergeOrderIds },
            },
            { $set: { sessionId: child._id } },
            { session: mongoSession },
          )
          .exec();
        if (restoredOrders.modifiedCount !== child.preMergeOrderIds.length)
          throw new ConflictException('Liên kết đơn hàng đã thay đổi');
        const restoredTables = await this.tableModel
          .updateMany(
            {
              _id: { $in: child.preMergeTableIds },
              currentSessionId: root._id,
            },
            {
              $set: {
                currentSessionId: child._id,
                status: TableStatus.OCCUPIED,
              },
              $inc: { __v: 1 },
            },
            { session: mongoSession },
          )
          .exec();
        if (restoredTables.modifiedCount !== child.preMergeTableIds.length)
          throw new ConflictException('Bàn vừa thay đổi');
      },
    );
    if (ungroupedTableIds) {
      return {
        case: 'ungrouped' as const,
        tableIds: ungroupedTableIds,
        status: TableStatus.AVAILABLE,
      };
    }
    return {
      case: 'session' as const,
      childSessionId: restoredChildSessionId!,
      rootSessionId: rootSessionId!,
      tableIds: restoredTableIds,
      status: SessionStatus.ACTIVE,
    };
  }
}
