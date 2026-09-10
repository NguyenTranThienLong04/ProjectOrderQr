import { rankRecommendations } from './recommendation-ranking';

const repeat = (count: number, basket: string[]) =>
  Array.from({ length: count }, () => basket);
describe('Deterministic basket ranking', () => {
  const baskets = [
    ...repeat(10, ['a', 'b']),
    ...repeat(5, ['a', 'c']),
    ...repeat(5, ['d']),
  ];
  it('one dish has exact pair count, confidence and support', () => {
    expect(rankRecommendations(baskets, ['a'])[0]).toEqual({
      dishId: 'b',
      reason: 'frequently_bought_together',
      evidence: {
        sampleSize: 20,
        anchorCount: 15,
        pairCount: 10,
        confidence: 10 / 15,
        support: 0.5,
        basketCount: 10,
      },
    });
  });
  it('multiple dishes use union baskets without double counting', () => {
    const result = rankRecommendations(
      [...repeat(10, ['a', 'b', 'c']), ...repeat(10, ['b', 'c'])],
      ['a', 'b'],
    );
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toMatchObject({
      anchorCount: 20,
      pairCount: 20,
      confidence: 1,
    });
  });
  it('ignores duplicate dish/note variants and quantity votes', () => {
    expect(
      rankRecommendations(
        baskets.map((b) => [...b, ...b]),
        ['a', 'a'],
      ),
    ).toEqual(rankRecommendations(baskets, ['a']));
  });
  it('is stable across source ordering and tie breaks by ID', () => {
    const data = repeat(20, ['a', 'c', 'b']);
    expect(rankRecommendations(data, ['a']).map((r) => r.dishId)).toEqual([
      'b',
      'c',
    ]);
    expect(rankRecommendations([...baskets].reverse(), ['a'])).toEqual(
      rankRecommendations(baskets, ['a']),
    );
  });
  it.each([0, 1, 2, 19])('returns empty for %s baskets', (count) => {
    expect(rankRecommendations(repeat(count, ['a', 'b']), ['a'])).toEqual([]);
  });
  it('does not count empty baskets in sample', () => {
    expect(rankRecommendations([...repeat(19, ['a', 'b']), []], ['a'])).toEqual(
      [],
    );
  });
  it('rejects weak pair counts even with a large anchor sample', () => {
    const result = rankRecommendations(
      [...repeat(2, ['a', 'b']), ...repeat(18, ['a'])],
      ['a'],
    );
    expect(result).toEqual([]);
  });
  it('labels weak pairs honestly as popular if independently supported', () => {
    const data = [
      ...repeat(2, ['a', 'b']),
      ...repeat(8, ['a']),
      ...repeat(10, ['b']),
    ];
    expect(rankRecommendations(data, ['a'])[0].reason).toBe('popular');
  });
  it('requires at least ten matching baskets', () => {
    expect(
      rankRecommendations(
        [...repeat(9, ['a', 'b']), ...repeat(11, ['c'])],
        ['a'],
      ).find((r) => r.dishId === 'b')?.reason,
    ).toBe('popular');
  });
  it('requires minimum support', () => {
    expect(
      rankRecommendations(
        [...repeat(5, ['a', 'b']), ...repeat(995, ['a'])],
        ['a'],
      )[0].reason,
    ).toBe('popular');
  });
  it.each([[[]], [['unknown']]])(
    'cold start uses only observed popularity for %j',
    (cart) => {
      expect(
        rankRecommendations(baskets, cart).every((r) => r.reason === 'popular'),
      ).toBe(true);
      expect(rankRecommendations(baskets, cart)[0].dishId).toBe('a');
    },
  );
  it('never returns cart dishes', () => {
    expect(
      rankRecommendations(baskets, ['a', 'b']).some((r) =>
        ['a', 'b'].includes(r.dishId),
      ),
    ).toBe(false);
  });
});
