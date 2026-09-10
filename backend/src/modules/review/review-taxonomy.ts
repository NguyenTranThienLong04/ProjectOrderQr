export const REVIEW_TAXONOMY_VERSION = 'review-topics-v1';
export const REVIEW_SENTIMENTS = [
  'positive',
  'neutral',
  'negative',
  'mixed',
] as const;
export type ReviewSentiment = (typeof REVIEW_SENTIMENTS)[number];
export const REVIEW_TOPICS = [
  'taste',
  'saltiness',
  'spiciness',
  'temperature',
  'portion',
  'presentation',
  'service_speed',
  'value',
  'other',
] as const;
export type ReviewTopic = (typeof REVIEW_TOPICS)[number];
export const REVIEW_TOPIC_LABELS: Record<ReviewTopic, string> = {
  taste: 'Hương vị',
  saltiness: 'Độ mặn',
  spiciness: 'Độ cay',
  temperature: 'Nhiệt độ',
  portion: 'Khẩu phần',
  presentation: 'Trình bày',
  service_speed: 'Tốc độ phục vụ',
  value: 'Giá trị so với giá',
  other: 'Khác',
};
