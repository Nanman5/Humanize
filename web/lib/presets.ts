export interface ResizePreset {
  id: string;
  label: string;
  w: number;
  h: number;
  group: string;
}

export const RESIZE_PRESETS: ResizePreset[] = [
  { id: "iphone-1170", label: "iPhone 13/14", w: 1170, h: 2532, group: "Wallpaper iPhone" },
  { id: "iphone-1284", label: "iPhone Pro Max", w: 1284, h: 2778, group: "Wallpaper iPhone" },
  { id: "iphone-1290", label: "iPhone 15 Pro Max", w: 1290, h: 2796, group: "Wallpaper iPhone" },
  { id: "iphone-1152", label: "1152×2048", w: 1152, h: 2048, group: "Wallpaper iPhone" },

  { id: "ig-square", label: "Square", w: 1080, h: 1080, group: "Instagram" },
  { id: "ig-portrait", label: "Portrait 4:5", w: 1080, h: 1350, group: "Instagram" },
  { id: "ig-story", label: "Story / Reel", w: 1080, h: 1920, group: "Instagram" },

  { id: "tiktok", label: "TikTok", w: 1080, h: 1920, group: "TikTok" },
];

export const PRESET_GROUPS: string[] = Array.from(
  new Set(RESIZE_PRESETS.map((p) => p.group)),
);

export function findPreset(w: number, h: number): ResizePreset | undefined {
  return RESIZE_PRESETS.find((p) => p.w === w && p.h === h);
}
