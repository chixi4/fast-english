export const DEFAULT_TRIGGER_RATIO = 0.3;
export const DEFAULT_ACTIVE_ZONE_RATIO = 0.8;

export type SwipeAction = "NONE" | "TOO_EASY" | "ADD_TO_NOTEBOOK";

export const triggerThreshold = (widthPx: number, triggerRatio: number = DEFAULT_TRIGGER_RATIO): number => {
  return Math.max(1, widthPx) * Math.max(0, Math.min(1, triggerRatio));
};

export const edgeReservedWidth = (widthPx: number, activeZoneRatio: number = DEFAULT_ACTIVE_ZONE_RATIO): number => {
  const safeWidth = Math.max(1, widthPx);
  const safeActiveZone = Math.max(0, Math.min(1, activeZoneRatio));
  return safeWidth * ((1 - safeActiveZone) / 2);
};

export const isStartInActiveZone = (
  startX: number,
  widthPx: number,
  activeZoneRatio: number = DEFAULT_ACTIVE_ZONE_RATIO,
): boolean => {
  const safeWidth = Math.max(1, widthPx);
  const reserved = edgeReservedWidth(safeWidth, activeZoneRatio);
  return startX >= reserved && startX <= safeWidth - reserved;
};

export const resolveSwipeAction = (offsetX: number, threshold: number): SwipeAction => {
  const safeThreshold = Math.max(1, threshold);
  if (offsetX <= -safeThreshold) return "TOO_EASY";
  if (offsetX >= safeThreshold) return "ADD_TO_NOTEBOOK";
  return "NONE";
};
