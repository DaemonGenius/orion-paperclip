import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ThemeMode } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";

type Theme = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  themeMode: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
const VAPORWAVE_THEME_COLOR = "#070816";
export const THEME_MODE_CHANGE_EVENT = "paperclip:theme-mode-change";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

interface ThemeModeChangeEvent extends CustomEvent {
  detail: {
    themeMode: ThemeMode;
  };
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark" || value === "vaporwave-neo-tokyo";
}

function resolveSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolveThemeFromMode(themeMode: ThemeMode): Theme {
  if (themeMode === "light") return "light";
  if (themeMode === "vaporwave-neo-tokyo") return "dark";
  if (themeMode === "system") return resolveSystemTheme();
  return "dark";
}

function resolveThemeModeFromDocument(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  if (document.documentElement.classList.contains("theme-vaporwave-neo-tokyo")) return "vaporwave-neo-tokyo";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function resolveThemeFromDocument(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(themeMode: ThemeMode) {
  if (typeof document === "undefined") return;
  const theme = resolveThemeFromMode(themeMode);
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.classList.toggle("theme-vaporwave-neo-tokyo", themeMode === "vaporwave-neo-tokyo");
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute(
      "content",
      themeMode === "vaporwave-neo-tokyo" ? VAPORWAVE_THEME_COLOR : isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR,
    );
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [localThemeMode, setLocalThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeMode(stored)) return stored;
    } catch {
      // Ignore local storage read failures in restricted environments.
    }
    return resolveThemeModeFromDocument();
  });
  const [instanceThemeMode, setInstanceThemeMode] = useState<ThemeMode | null>(null);
  const [systemTheme, setSystemTheme] = useState<Theme>(() => resolveSystemTheme());
  const themeMode = instanceThemeMode ?? localThemeMode;
  const theme = themeMode === "system" ? systemTheme : resolveThemeFromMode(themeMode);

  const setTheme = useCallback((nextTheme: ThemeMode) => {
    setInstanceThemeMode(null);
    setLocalThemeMode(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setInstanceThemeMode(null);
    setLocalThemeMode((current) => {
      const resolved = resolveThemeFromMode(current);
      return resolved === "dark" ? "light" : "dark";
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;
    const handleChange = () => setSystemTheme(resolveSystemTheme());
    handleChange();
    media.addEventListener?.("change", handleChange);
    return () => media.removeEventListener?.("change", handleChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    instanceSettingsApi.getGeneral()
      .then((settings) => {
        if (!cancelled) setInstanceThemeMode(settings.themeMode ?? "system");
      })
      .catch(() => {
        // Keep the local/document fallback when instance settings are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleThemeModeChange = (event: Event) => {
      const { themeMode: nextThemeMode } = (event as ThemeModeChangeEvent).detail ?? {};
      if (isThemeMode(nextThemeMode)) setInstanceThemeMode(nextThemeMode);
    };
    window.addEventListener(THEME_MODE_CHANGE_EVENT, handleThemeModeChange);
    return () => window.removeEventListener(THEME_MODE_CHANGE_EVENT, handleThemeModeChange);
  }, []);

  useEffect(() => {
    applyTheme(themeMode);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [themeMode]);

  const value = useMemo(
    () => ({
      theme,
      themeMode,
      setTheme,
      toggleTheme,
    }),
    [theme, themeMode, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
