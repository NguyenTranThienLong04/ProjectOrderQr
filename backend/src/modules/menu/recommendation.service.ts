import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrderStatus } from '../../common/enums/order-status.enum';
import { SessionStatus } from '../../common/enums/session-status.enum';
import { Order } from '../order/order.schema';
import { Session } from '../session/session.schema';
import { Table } from '../table/table.schema';
import { MenuService } from './menu.service';
import { RecommendMenuDto } from './dto/recommend-menu.dto';
import { matchesMenuFilters, searchWarnings } from './menu-search';
import {
  rankRecommendations,
  RECOMMENDATION_POLICY,
} from './recommendation-ranking';

@Injectable()
export class RecommendationService {
  // Cache only bounded historical identities, never live dishes/constraints/results.
  // A single shared promise coalesces concurrent cold requests across all tables.
  private history?: { expiresAt: number; baskets: string[][] };
  private pending?: Promise<string[][]>;
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(Table.name) private readonly tables: Model<Table>,
    private readonly menu: MenuService,
  ) {}

  private async getHistory(): Promise<string[][]> {
    if (this.history && this.history.expiresAt > Date.now())
      return this.history.baskets;
    if (this.pending) return this.pending;
    const request = this.orders
      .find({
        status: { $in: [OrderStatus.SERVED, OrderStatus.PAID] },
        createdAt: {
          $gte: new Date(
            Date.now() - RECOMMENDATION_POLICY.historyDays * 86400000,
          ),
        },
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(RECOMMENDATION_POLICY.historyLimit)
      .select('items.dishId items.status')
      .maxTimeMS(5000)
      .lean()
      .exec()
      .then((orders) =>
        orders.map((order) => [
          ...new Set(
            order.items
              .filter((item) =>
                [OrderStatus.SERVED, OrderStatus.PAID].includes(item.status),
              )
              .map((item) => item.dishId?.toString())
              .filter((id): id is string => !!id && /^[a-f\d]{24}$/i.test(id)),
          ),
        ]),
      )
      .then((baskets) => {
        this.history = {
          baskets,
          expiresAt: Date.now() + RECOMMENDATION_POLICY.ttlMs,
        };
        return baskets;
      })
      .finally(() => {
        this.pending = undefined;
      });
    this.pending = request;
    return request;
  }

  async recommend(dto: RecommendMenuDto) {
    const session = await this.sessions
      .findOne({ _id: dto.sessionId, status: SessionStatus.ACTIVE })
      .lean()
      .exec();
    const table = await this.tables.findById(dto.tableId).lean().exec();
    if (
      !session ||
      !table ||
      table.currentSessionId?.toString() !== dto.sessionId.toLowerCase() ||
      !(session.tableIds?.length ? session.tableIds : [session.tableId]).some(
        (id) => id.toString() === dto.tableId.toLowerCase(),
      )
    ) {
      throw new ForbiddenException('Phiên ăn hoặc bàn không hợp lệ.');
    }
    try {
      const history = await this.getHistory();
      const cartDishIds = [
        ...new Set(session.cart.map((item) => item.dishId.toString())),
      ].sort();
      const ranked = rankRecommendations(history, cartDishIds);
      // Fresh authoritative catalog AFTER history work; cached history cannot resurrect a dish.
      const { dishes, categories } = await this.menu.getSearchCatalog(
        dto.tableId,
      );
      const constraints = dto.constraints ?? {};
      const lang = dto.lang ?? 'vi';
      const warnings: string[] = [];
      if (constraints.excludedAllergens?.length)
        warnings.push(searchWarnings(lang).allergy);
      const eligible = new Map(
        dishes
          .filter((dish) => {
            const category = categories.find(
              (c) => c._id.toString() === dish.categoryId.toString(),
            );
            return matchesMenuFilters(
              dish,
              [category?.name ?? '', category?.nameEn ?? ''],
              constraints,
            );
          })
          .map((dish) => [dish._id.toString(), dish]),
      );
      const recommendations = ranked
        .filter((item) => eligible.has(item.dishId))
        .slice(0, RECOMMENDATION_POLICY.limit)
        .map(({ dishId, ...item }) => {
          const dish = eligible.get(dishId)!;
          return {
            ...item,
            dish: {
              ...dish,
              name:
                lang === 'en' ? dish.nameEn?.trim() || dish.name : dish.name,
              description:
                lang === 'en'
                  ? dish.descriptionEn?.trim() || dish.description
                  : dish.description,
            },
          };
        });
      if (
        !recommendations.some(
          (item) => item.reason === 'frequently_bought_together',
        )
      ) {
        warnings.push(
          lang === 'vi'
            ? 'Chưa đủ dữ liệu để gợi ý món thường gọi cùng. Món phổ biến chỉ hiển thị khi có đủ lịch sử.'
            : 'Not enough evidence for dishes ordered together. Popular dishes appear only with sufficient history.',
        );
      }
      return {
        result: {
          recommendations,
          cartDishIds,
          sampleSize: history.filter((b) => b.length).length,
        },
        warnings,
      };
    } catch {
      throw new ServiceUnavailableException('Tạm thời chưa thể tải gợi ý món.');
    }
  }
}
