import de from "./de";
import { en, type TranslationKey } from "./en";
import es from "./es";
import fr from "./fr";
import it from "./it";
import nl from "./nl";
import pt from "./pt";
import {
  POCKET_FLAGSHIP_ROLES,
  VOICE_AGE_LABELS,
  VOICE_DESCRIPTIONS,
  VOICE_GENDER_LABELS,
  type PocketFlagshipSlug,
  type VoiceAgeKey,
  type VoiceGenderKey,
} from "./voices";

export type AppLanguage = "en" | "fr" | "de" | "es" | "pt" | "it" | "nl";
export type { TranslationKey };

export interface LanguageMeta {
  code: AppLanguage;
  nativeName: string;
  englishName: string;
  modelName: string;
  engineLabel: string;
  sizeMb: number;
  defaultVoiceName: string;
  samplePreviewText: string;
}

export const SUPPORTED_LANGUAGES: LanguageMeta[] = [
  {
    code: "en",
    nativeName: "English",
    englishName: "English",
    modelName: "Phonon 31M",
    engineLabel: "Gradium Phonon 31M",
    sizeMb: 65,
    defaultVoiceName: "Easton",
    samplePreviewText: "The quick brown fox reads smoothly across every page.",
  },
  {
    code: "fr",
    nativeName: "Français",
    englishName: "French",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Estelle",
    samplePreviewText: "Bonjour, bienvenue dans BookReader. Bonne lecture.",
  },
  {
    code: "de",
    nativeName: "Deutsch",
    englishName: "German",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Juergen",
    samplePreviewText: "Hallo und willkommen bei BookReader. Viel Freude beim Lesen.",
  },
  {
    code: "es",
    nativeName: "Español",
    englishName: "Spanish",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Lola",
    samplePreviewText: "Hola y bienvenido a BookReader. Disfruta de tu lectura.",
  },
  {
    code: "pt",
    nativeName: "Português",
    englishName: "Portuguese",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Rafael",
    samplePreviewText: "Olá e bem-vindo ao BookReader. Boa leitura.",
  },
  {
    code: "it",
    nativeName: "Italiano",
    englishName: "Italian",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Giovanni",
    samplePreviewText: "Ciao e benvenuto in BookReader. Buona lettura.",
  },
  {
    code: "nl",
    nativeName: "Nederlands",
    englishName: "Dutch",
    modelName: "Kyutai Pocket TTS",
    engineLabel: "Kyutai Pocket TTS",
    sizeMb: 209,
    defaultVoiceName: "Daan",
    samplePreviewText: "Hallo en welkom bij BookReader. Veel leesplezier.",
  },
];

const LOCALE_MAP: Record<AppLanguage, Record<TranslationKey, string>> = {
  en,
  fr,
  de,
  es,
  pt,
  it,
  nl,
};

const SUPPORTED_CODE_SET = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));

let activeUiLanguage: AppLanguage = "en";

export function isSupportedLanguage(code: string | null | undefined): code is AppLanguage {
  return typeof code === "string" && SUPPORTED_CODE_SET.has(code);
}

export function getLanguageMeta(lang: AppLanguage): LanguageMeta {
  return SUPPORTED_LANGUAGES.find((l) => l.code === lang) ?? SUPPORTED_LANGUAGES[0];
}

export function detectSystemLanguage(): AppLanguage {
  if (typeof navigator === "undefined") return "en";
  const candidates: string[] = [];
  if (Array.isArray(navigator.languages)) {
    candidates.push(...navigator.languages);
  }
  if (typeof navigator.language === "string") {
    candidates.push(navigator.language);
  }
  for (const raw of candidates) {
    const prefix = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
    if (isSupportedLanguage(prefix)) {
      return prefix;
    }
  }
  return "en";
}

export function getUiLanguage(uiLang?: AppLanguage | null): AppLanguage {
  if (isSupportedLanguage(uiLang)) {
    return uiLang;
  }
  return detectSystemLanguage();
}

export function getActiveUiLanguage(): AppLanguage {
  return activeUiLanguage;
}

export function setActiveUiLanguage(uiLang?: AppLanguage | null): AppLanguage {
  activeUiLanguage = getUiLanguage(uiLang);
  if (typeof document !== "undefined") {
    document.documentElement.lang = activeUiLanguage;
  }
  return activeUiLanguage;
}

export function t(
  lang: AppLanguage,
  key: TranslationKey,
  vars?: Record<string, string | number>,
): string {
  const dict = LOCALE_MAP[lang] ?? en;
  let template = dict[key] ?? en[key] ?? String(key);
  if (vars) {
    template = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const val = vars[name];
      return val !== undefined ? String(val) : `{${name}}`;
    });
  }
  return template;
}

export function tr(key: TranslationKey, vars?: Record<string, string | number>): string {
  return t(activeUiLanguage, key, vars);
}

function normalizeVoiceKey(voiceIdOrSlug: string): string {
  if (voiceIdOrSlug.startsWith("pocket:")) {
    const parts = voiceIdOrSlug.split(":");
    return parts[parts.length - 1] || voiceIdOrSlug;
  }
  return voiceIdOrSlug;
}

export function tVoiceDesc(
  lang: AppLanguage,
  voiceIdOrSlug: string,
  fallback = "",
): string {
  const exact = VOICE_DESCRIPTIONS[voiceIdOrSlug];
  if (exact) {
    return exact[lang] ?? exact.en ?? fallback;
  }
  const normalized = normalizeVoiceKey(voiceIdOrSlug);
  const bySlug = VOICE_DESCRIPTIONS[normalized];
  if (bySlug) {
    return bySlug[lang] ?? bySlug.en ?? fallback;
  }
  return fallback;
}

export function tVoiceGender(lang: AppLanguage, gender: string): string {
  const key = gender.trim().toLowerCase() as VoiceGenderKey;
  const table = VOICE_GENDER_LABELS[lang] ?? VOICE_GENDER_LABELS.en;
  return table[key] ?? gender;
}

export function tVoiceAge(lang: AppLanguage, age: string): string {
  const table = VOICE_AGE_LABELS[lang] ?? VOICE_AGE_LABELS.en;
  if (age in table) {
    return table[age as VoiceAgeKey];
  }
  const lowered = age.trim().toLowerCase();
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === lowered) {
      return v;
    }
  }
  return age;
}

export function tPocketFlagshipRole(lang: AppLanguage, voiceSlug: string): string {
  const slug = normalizeVoiceKey(voiceSlug) as PocketFlagshipSlug;
  const table = POCKET_FLAGSHIP_ROLES[lang] ?? POCKET_FLAGSHIP_ROLES.en;
  return table[slug] ?? "";
}
