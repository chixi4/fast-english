export const lightTheme = {
  primary: "#2E5CCB",
  primaryDeep: "#1F3F93",
  secondary: "#6E88E8",
  background: "#F4F7FF",
  surface: "#FFFFFF",
  surfaceSoft: "#F8FAFF",
  textPrimary: "#1F2A44",
  textSecondary: "#6D7895",
  outline: "#BAC6E3",
  error: "#E55A5A",
  fuzzy: "#E0AB42",
  known: "#4AA978",
  positiveContainer: "#E4F5EC",
  blueContainer: "#E1E8FF",
};

export const darkTheme = {
  primary: "#AEC4FF",
  primaryDeep: "#AEC4FF",
  secondary: "#AEC4FF",
  background: "#11162A",
  surface: "#1A233C",
  surfaceSoft: "#212D4B",
  textPrimary: "#EAF0FF",
  textSecondary: "#BAC6E3",
  outline: "#BAC6E3",
  error: "#E55A5A",
  fuzzy: "#E0AB42",
  known: "#4AA978",
  positiveContainer: "#1F3F2E",
  blueContainer: "#25345E",
};

export const fontScaleClass = (value: number): string => {
  if (value <= 0.9) return "font-scale-small";
  if (value >= 1.1) return "font-scale-large";
  return "font-scale-normal";
};
