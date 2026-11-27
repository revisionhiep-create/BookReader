//! Complete voice catalog for Gradium Phonon 31M (37 EN voices) and
//! Kyutai Pocket TTS (27 voices across 6 European languages: fr, de, es, pt, it, nl).

use crate::models::{AppLanguage, ClonedVoiceMeta, VoiceInfo};
use crate::paths::AppPaths;

/// Static entry describing one voice in the Gradium Phonon English catalog.
#[derive(Clone, Copy, Debug)]
pub struct CatalogEntry {
    pub voice_id: &'static str,
    pub name: &'static str,
    pub locale: &'static str,
    pub gender: &'static str,
    pub age: &'static str,
    pub description: &'static str,
}

/// Static entry describing one speaker embedding in Kyutai Pocket TTS.
#[derive(Clone, Copy, Debug)]
pub struct PocketVoiceEntry {
    pub slug: &'static str,
    pub name: &'static str,
    pub gender: &'static str,
    pub age: &'static str,
    pub description: &'static str,
}

/// All 37 English voices (6 US female, 6 US male, 7 UK female, 6 UK male, 12 characters).
pub const EN_VOICES: &[CatalogEntry] = &[
    // US Female (6)
    CatalogEntry {
        voice_id: "NbpkqMVS3CJeq2j8",
        name: "Zoey",
        locale: "en-us",
        gender: "female",
        age: "Adult",
        description: "Playful, upbeat American voice with engaging conversational warmth.",
    },
    CatalogEntry {
        voice_id: "NIWIOv5vTi5eRMj8",
        name: "Juniper",
        locale: "en-us",
        gender: "female",
        age: "Young Adult",
        description: "Cheerful presence with warm resonance, personable and clear.",
    },
    CatalogEntry {
        voice_id: "vjFyp2BcCyTlUmYb",
        name: "Everly",
        locale: "en-us",
        gender: "female",
        age: "Middle-age",
        description: "Rounded, soft-edged tone with an easy, relaxed storytelling delivery.",
    },
    CatalogEntry {
        voice_id: "4SZHfMpw-p46Ywgs",
        name: "Harper",
        locale: "en-us",
        gender: "female",
        age: "Adult",
        description: "Modern, confident, and friendly standard American voice.",
    },
    CatalogEntry {
        voice_id: "bXwrkHhURL1VFJdG",
        name: "Hadley",
        locale: "en-us",
        gender: "female",
        age: "Middle-age",
        description: "Settled, even-toned, and genuinely kind with crisp consonants.",
    },
    CatalogEntry {
        voice_id: "nGzMHMPAWGaJFHOo",
        name: "Delia",
        locale: "en-us",
        gender: "female",
        age: "Middle-age",
        description: "Low, grounded, and sincere delivery ideal for earnest prose.",
    },
    // US Male (6)
    CatalogEntry {
        voice_id: "LMDIYE0Oa377Qh6Z",
        name: "Easton",
        locale: "en-us",
        gender: "male",
        age: "Young Adult",
        description: "Punchy and close in, with crisp consonant attack and expressive lift.",
    },
    CatalogEntry {
        voice_id: "40QrMVgAxFiUnP9f",
        name: "Micah",
        locale: "en-us",
        gender: "male",
        age: "Young Adult",
        description: "Buoyant and energetic with clean, clear articulation.",
    },
    CatalogEntry {
        voice_id: "0zLApsZfVLLNaEGl",
        name: "Trevor",
        locale: "en-us",
        gender: "male",
        age: "Middle-age",
        description: "Buoyant energy over a resonant mid-low core with soft phrase landings.",
    },
    CatalogEntry {
        voice_id: "_6Aslh2DxfmnRLmP",
        name: "Russell",
        locale: "en-us",
        gender: "male",
        age: "Adult",
        description: "High-energy American adult voice with clear, motivating intensity.",
    },
    CatalogEntry {
        voice_id: "qIxlZ7Ei8KvWlyQH",
        name: "Preston",
        locale: "en-us",
        gender: "male",
        age: "Middle-age",
        description: "Trim, focused delivery with clean edges and a steady, low-set core.",
    },
    CatalogEntry {
        voice_id: "d9XCyhjo4JhkHF1d",
        name: "Miles",
        locale: "en-us",
        gender: "male",
        age: "Young Adult",
        description: "Resonant and decisive narrator with strong dynamic range.",
    },
    // UK Female (7)
    CatalogEntry {
        voice_id: "6PWnV0Nq4wu7RVBT",
        name: "Maeve",
        locale: "en-gb",
        gender: "female",
        age: "Adult",
        description: "Sparky, attentive British voice that stays clear and natural.",
    },
    CatalogEntry {
        voice_id: "GgfEkEJtxZR7gnpy",
        name: "Freya",
        locale: "en-gb",
        gender: "female",
        age: "Young",
        description: "Young British voice, glossy and confident with lively brightness.",
    },
    CatalogEntry {
        voice_id: "uem82D50GRv2Dwma",
        name: "Pippa",
        locale: "en-gb",
        gender: "female",
        age: "Adult",
        description: "Confident, upbeat British adult voice with expressive pacing.",
    },
    CatalogEntry {
        voice_id: "y9bQqIDnyxwqK01t",
        name: "Elodie-Rose",
        locale: "en-gb",
        gender: "female",
        age: "Young",
        description: "Young British voice with enthusiastic energy and crisp articulation.",
    },
    CatalogEntry {
        voice_id: "gDT1nz7Ie36ZhL-C",
        name: "Imogen",
        locale: "en-gb",
        gender: "female",
        age: "Adult",
        description: "Warm, friendly British voice that feels calm and inviting.",
    },
    CatalogEntry {
        voice_id: "m9MxpY6IUGXtWp76",
        name: "Lottie",
        locale: "en-gb",
        gender: "female",
        age: "Young Adult",
        description: "Sparky and direct with clean consonants and expressive pitch range.",
    },
    CatalogEntry {
        voice_id: "gfP44RlHwr2kEwk7",
        name: "Bryony",
        locale: "en-gb",
        gender: "female",
        age: "Middle-age",
        description: "Full, rich mid-range tones, softly relaxed and intimate.",
    },
    // UK Male (6)
    CatalogEntry {
        voice_id: "X6NceqF285Gr04gb",
        name: "Alfie",
        locale: "en-gb",
        gender: "male",
        age: "Young Adult",
        description: "Punchy and forward British voice with crisp consonant attack.",
    },
    CatalogEntry {
        voice_id: "YyKcxPG7iIgS3jsK",
        name: "Hugh",
        locale: "en-gb",
        gender: "male",
        age: "Middle-age",
        description: "Soft and close, airy in texture, with an attentive sincere delivery.",
    },
    CatalogEntry {
        voice_id: "zUCxzrOrugTSis03",
        name: "Edwin",
        locale: "en-gb",
        gender: "male",
        age: "Middle-age",
        description: "Efficient and firm British voice with tidy, measured articulation.",
    },
    CatalogEntry {
        voice_id: "JOW0vchyswkQUMDS",
        name: "Spencer",
        locale: "en-gb",
        gender: "male",
        age: "Middle-age",
        description: "Light and airy British voice with a patient, unhurried cadence.",
    },
    CatalogEntry {
        voice_id: "dME3IWyZBvmh1n1q",
        name: "Toby",
        locale: "en-gb",
        gender: "male",
        age: "Adult",
        description: "Attentive British adult voice with natural conversational flow.",
    },
    CatalogEntry {
        voice_id: "Zn7g6NxLqXlJb7Qi",
        name: "Teddy",
        locale: "en-gb",
        gender: "male",
        age: "Young Adult",
        description: "Close, articulate British delivery with strong expressive shifts.",
    },
    // English Character Voices (12)
    CatalogEntry {
        voice_id: "xPDpsV3F592srkjA",
        name: "Captain Silas Blackwater",
        locale: "characters",
        gender: "character",
        age: "Older",
        description: "Deep, gravelly West Country sea captain with hearty roguish flair.",
    },
    CatalogEntry {
        voice_id: "nOykTmcH9ydsGGIc",
        name: "Morwenna of the Deep",
        locale: "characters",
        gender: "character",
        age: "Adult",
        description: "Low, husky alto, slow and intimate with a hint of mystery.",
    },
    CatalogEntry {
        voice_id: "lX3LavMNdlIbgEHH",
        name: "Old Mortlake",
        locale: "characters",
        gender: "character",
        age: "Elderly",
        description: "Low, raspy Victorian storyteller with heavy, deliberate pauses.",
    },
    CatalogEntry {
        voice_id: "dGyGDKo2osj7h3s7",
        name: "Azgorath",
        locale: "characters",
        gender: "character",
        age: "Ancient",
        description: "Cavernous, impossibly deep bass voice with calm, measured menace.",
    },
    CatalogEntry {
        voice_id: "cXoIXJ2llS8S0WOW",
        name: "Fennick the Young Elf",
        locale: "characters",
        gender: "character",
        age: "Youth",
        description: "Warm, earnest young fantasy voice full of wide-eyed curiosity.",
    },
    CatalogEntry {
        voice_id: "GXaSqMEmOg12OIYb",
        name: "The Thing Under the Stairs",
        locale: "characters",
        gender: "character",
        age: "Unknown",
        description: "Gravelly, breathy creature whisper pitched low for eerie tales.",
    },
    CatalogEntry {
        voice_id: "xO8xQo3BrB8FuI6J",
        name: "Vyrmathrax the Ancient",
        locale: "characters",
        gender: "character",
        age: "Ancient",
        description: "Deep, resonant dragon voice with dry, unhurried gravitas.",
    },
    CatalogEntry {
        voice_id: "cYtsRSxV5q9IMehn",
        name: "Grub the Ogre",
        locale: "characters",
        gender: "character",
        age: "Adult",
        description: "Gruff, good-natured low rumble with lumbering rhythm and warmth.",
    },
    CatalogEntry {
        voice_id: "gSgG5Tor0GPEnqzC",
        name: "Master Aldric",
        locale: "characters",
        gender: "character",
        age: "Elderly",
        description: "Wise old British wizard with rich resonance and kindly cadence.",
    },
    CatalogEntry {
        voice_id: "NIWoEurJHMJjyUTe",
        name: "The Snow Queen",
        locale: "characters",
        gender: "character",
        age: "Adult",
        description: "Cool, crystalline mezzo voice, poised and quietly commanding.",
    },
    CatalogEntry {
        voice_id: "y2eiKxtQo2B67deU",
        name: "Sir Bramwell",
        locale: "characters",
        gender: "character",
        age: "Middle-age",
        description: "Booming, theatrical English knight full of grand bravado.",
    },
    CatalogEntry {
        voice_id: "QXNr0SvkukLB4wPq",
        name: "Fairy Godmother",
        locale: "characters",
        gender: "character",
        age: "Older",
        description: "Warm, velvety alto voice, cozy, unhurried, and reassuring.",
    },
];

/// All 27 precomputed speaker voices shipped for each Kyutai Pocket TTS language.
pub const POCKET_VOICES: &[PocketVoiceEntry] = &[
    PocketVoiceEntry {
        slug: "alba",
        name: "Alba",
        gender: "female",
        age: "Young Adult",
        description: "Bright, clear voice with gentle cadence and crisp diction.",
    },
    PocketVoiceEntry {
        slug: "anna",
        name: "Anna",
        gender: "female",
        age: "Adult",
        description: "Balanced, composed narrator with smooth, steady pacing.",
    },
    PocketVoiceEntry {
        slug: "azelma",
        name: "Azelma",
        gender: "female",
        age: "Young Adult",
        description: "Soft-spoken, delicate tone suited to intimate prose.",
    },
    PocketVoiceEntry {
        slug: "bill_boerst",
        name: "Bill Boerst",
        gender: "male",
        age: "Older",
        description: "Classic, seasoned storyteller with warm, unhurried depth.",
    },
    PocketVoiceEntry {
        slug: "caro_davy",
        name: "Caro Davy",
        gender: "female",
        age: "Adult",
        description: "Poised, articulate narrator with light, natural warmth.",
    },
    PocketVoiceEntry {
        slug: "charles",
        name: "Charles",
        gender: "male",
        age: "Middle-age",
        description: "Refined, calm voice with measured, formal poise.",
    },
    PocketVoiceEntry {
        slug: "cosette",
        name: "Cosette",
        gender: "female",
        age: "Young",
        description: "Light, earnest, and lyrical voice with gentle expression.",
    },
    PocketVoiceEntry {
        slug: "daan",
        name: "Daan",
        gender: "male",
        age: "Adult",
        description: "Clear, friendly narrator with relaxed, natural delivery.",
    },
    PocketVoiceEntry {
        slug: "eponine",
        name: "Éponine",
        gender: "female",
        age: "Young Adult",
        description: "Grounded, emotive voice with vivid dramatic character.",
    },
    PocketVoiceEntry {
        slug: "estelle",
        name: "Estelle",
        gender: "female",
        age: "Adult",
        description: "Warm, natural narrator with clear, expressive phrasing.",
    },
    PocketVoiceEntry {
        slug: "eve",
        name: "Eve",
        gender: "female",
        age: "Adult",
        description: "Crisp, modern, and attentive delivery with clean pacing.",
    },
    PocketVoiceEntry {
        slug: "fantine",
        name: "Fantine",
        gender: "female",
        age: "Adult",
        description: "Tender, soulful voice with expressive emotional nuance.",
    },
    PocketVoiceEntry {
        slug: "george",
        name: "George",
        gender: "male",
        age: "Middle-age",
        description: "Resonant, reassuring voice with traditional narrative gravity.",
    },
    PocketVoiceEntry {
        slug: "giovanni",
        name: "Giovanni",
        gender: "male",
        age: "Adult",
        description: "Rich, melodic narrator with expressive, natural cadence.",
    },
    PocketVoiceEntry {
        slug: "jane",
        name: "Jane",
        gender: "female",
        age: "Adult",
        description: "Clear, poised narrator with natural, unhurried clarity.",
    },
    PocketVoiceEntry {
        slug: "javert",
        name: "Javert",
        gender: "male",
        age: "Middle-age",
        description: "Firm, commanding baritone with disciplined, serious cadence.",
    },
    PocketVoiceEntry {
        slug: "jean",
        name: "Jean",
        gender: "male",
        age: "Middle-age",
        description: "Deep, earnest voice with strong weight and steady warmth.",
    },
    PocketVoiceEntry {
        slug: "juergen",
        name: "Jürgen",
        gender: "male",
        age: "Adult",
        description: "Measured, authoritative narrator with crisp articulation.",
    },
    PocketVoiceEntry {
        slug: "lola",
        name: "Lola",
        gender: "female",
        age: "Adult",
        description: "Warm, expressive narrator with natural conversational flow.",
    },
    PocketVoiceEntry {
        slug: "marius",
        name: "Marius",
        gender: "male",
        age: "Young Adult",
        description: "Youthful, ardent voice with lively conversational flow.",
    },
    PocketVoiceEntry {
        slug: "mary",
        name: "Mary",
        gender: "female",
        age: "Middle-age",
        description: "Warm, kindly voice with comforting, steady narration.",
    },
    PocketVoiceEntry {
        slug: "michael",
        name: "Michael",
        gender: "male",
        age: "Adult",
        description: "Clean, versatile narrator with even, approachable tone.",
    },
    PocketVoiceEntry {
        slug: "paul",
        name: "Paul",
        gender: "male",
        age: "Adult",
        description: "Crisp, direct delivery with clear, confident articulation.",
    },
    PocketVoiceEntry {
        slug: "peter_yearsley",
        name: "Peter Yearsley",
        gender: "male",
        age: "Older",
        description: "Rich, distinguished voice with theatrical storytelling flair.",
    },
    PocketVoiceEntry {
        slug: "rafael",
        name: "Rafael",
        gender: "male",
        age: "Adult",
        description: "Smooth, articulate narrator with steady narrative pacing.",
    },
    PocketVoiceEntry {
        slug: "stuart_bell",
        name: "Stuart Bell",
        gender: "male",
        age: "Middle-age",
        description: "Steady, understated voice with clear, natural cadence.",
    },
    PocketVoiceEntry {
        slug: "vera",
        name: "Vera",
        gender: "female",
        age: "Adult",
        description: "Calm, resonant voice with thoughtful, measured pacing.",
    },
];

pub fn find_voice(voice_id: &str) -> Option<&'static CatalogEntry> {
    EN_VOICES.iter().find(|v| v.voice_id == voice_id)
}

pub fn find_pocket_voice(slug: &str) -> Option<&'static PocketVoiceEntry> {
    POCKET_VOICES.iter().find(|v| v.slug == slug)
}

pub fn pocket_voice_id(lang: AppLanguage, slug: &str) -> String {
    format!("pocket:{}:{slug}", lang.code())
}

pub fn pocket_native_slug(lang: AppLanguage) -> Option<&'static str> {
    match lang {
        AppLanguage::En => None,
        AppLanguage::Fr => Some("estelle"),
        AppLanguage::De => Some("juergen"),
        AppLanguage::Es => Some("lola"),
        AppLanguage::Pt => Some("rafael"),
        AppLanguage::It => Some("giovanni"),
        AppLanguage::Nl => Some("daan"),
    }
}

pub fn voice_download_url(voice_id: &str) -> String {
    format!(
        "https://huggingface.co/gradium/phonon-voices/resolve/main/voices/{voice_id}.safetensors"
    )
}

pub fn pocket_voice_download_url(lang: AppLanguage, slug: &str) -> Result<String, String> {
    let folder = lang
        .pocket_folder()
        .ok_or_else(|| format!("Language {} does not use Pocket TTS voices", lang.code()))?;
    Ok(format!(
        "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/languages/{folder}/embeddings/{slug}.safetensors"
    ))
}

/// Picks an already-downloaded built-in fallback voice (preferring default Easton).
pub fn pick_downloaded_fallback_voice(paths: &AppPaths) -> String {
    const DEFAULT_VOICE_ID: &str = "LMDIYE0Oa377Qh6Z";
    if paths.is_voice_downloaded(DEFAULT_VOICE_ID) {
        return DEFAULT_VOICE_ID.to_string();
    }
    EN_VOICES
        .iter()
        .find(|v| paths.is_voice_downloaded(v.voice_id))
        .map(|v| v.voice_id.to_string())
        .unwrap_or_else(|| "default".to_string())
}

/// Picks an already-downloaded fallback voice for `lang` (preferring its flagship default voice).
pub fn pick_downloaded_fallback_voice_for_lang(paths: &AppPaths, lang: AppLanguage) -> String {
    if lang == AppLanguage::En {
        return pick_downloaded_fallback_voice(paths);
    }
    let flagship = lang.default_voice_id();
    if paths.is_voice_downloaded(flagship) {
        return flagship.to_string();
    }
    for entry in POCKET_VOICES {
        let vid = pocket_voice_id(lang, entry.slug);
        if paths.is_voice_downloaded(&vid) {
            return vid;
        }
    }
    flagship.to_string()
}

pub fn list_voices_with_status(paths: &AppPaths, cloned: &[ClonedVoiceMeta]) -> Vec<VoiceInfo> {
    let mut out: Vec<VoiceInfo> = EN_VOICES
        .iter()
        .map(|v| VoiceInfo {
            voice_id: v.voice_id.to_string(),
            name: v.name.to_string(),
            language: "en".to_string(),
            locale: v.locale.to_string(),
            gender: v.gender.to_string(),
            age: v.age.to_string(),
            description: v.description.to_string(),
            downloaded: paths.is_voice_downloaded(v.voice_id),
            engine: "phonon".to_string(),
            is_cloned: false,
            is_native: false,
        })
        .collect();

    for lang in AppLanguage::all()
        .into_iter()
        .filter(|&l| l != AppLanguage::En)
    {
        let native_slug = pocket_native_slug(lang);
        if let Some(slug) = native_slug
            && let Some(entry) = find_pocket_voice(slug)
        {
            let vid = pocket_voice_id(lang, entry.slug);
            out.push(VoiceInfo {
                voice_id: vid.clone(),
                name: entry.name.to_string(),
                language: lang.code().to_string(),
                locale: lang.code().to_string(),
                gender: entry.gender.to_string(),
                age: entry.age.to_string(),
                description: entry.description.to_string(),
                downloaded: paths.is_voice_downloaded(&vid),
                engine: "pocket".to_string(),
                is_cloned: false,
                is_native: true,
            });
        }
        for entry in POCKET_VOICES {
            if Some(entry.slug) == native_slug {
                continue;
            }
            let vid = pocket_voice_id(lang, entry.slug);
            out.push(VoiceInfo {
                voice_id: vid.clone(),
                name: entry.name.to_string(),
                language: lang.code().to_string(),
                locale: lang.code().to_string(),
                gender: entry.gender.to_string(),
                age: entry.age.to_string(),
                description: entry.description.to_string(),
                downloaded: paths.is_voice_downloaded(&vid),
                engine: "pocket".to_string(),
                is_cloned: false,
                is_native: false,
            });
        }
    }

    for c in cloned {
        out.push(VoiceInfo {
            voice_id: c.voice_id.clone(),
            name: c.name.clone(),
            language: "cloned".to_string(),
            locale: "cloned".to_string(),
            gender: "cloned".to_string(),
            age: format!(
                "{:.1}s · {}",
                c.duration_sec,
                if c.icl_mode { "ICL" } else { "X-Vector" }
            ),
            description: c.description.clone(),
            downloaded: paths.is_voice_downloaded(&c.voice_id),
            engine: "qwen_clone".to_string(),
            is_cloned: true,
            is_native: false,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_voice_prefers_downloaded_builtin_over_uncached_voices() {
        let root = std::env::temp_dir().join(format!("bookreader_voice_fb_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();

        assert_eq!(pick_downloaded_fallback_voice(&paths), "default");

        std::fs::write(paths.voice_path("NbpkqMVS3CJeq2j8").unwrap(), b"ok").unwrap();
        assert_eq!(pick_downloaded_fallback_voice(&paths), "NbpkqMVS3CJeq2j8");

        std::fs::write(paths.voice_path("LMDIYE0Oa377Qh6Z").unwrap(), b"easton").unwrap();
        assert_eq!(pick_downloaded_fallback_voice(&paths), "LMDIYE0Oa377Qh6Z");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pocket_catalog_pins_single_native_voice_first_per_language() {
        let root = std::env::temp_dir().join(format!("bookreader_pocket_cat_{}", uuid::Uuid::new_v4()));
        let paths = AppPaths::from_roots(root.join("appdata"), root.join("data")).unwrap();
        let all = list_voices_with_status(&paths, &[]);

        assert_eq!(POCKET_VOICES.len(), 27);
        assert_eq!(all.iter().filter(|v| v.language == "en").count(), 37);

        for lang in [
            AppLanguage::Fr,
            AppLanguage::De,
            AppLanguage::Es,
            AppLanguage::Pt,
            AppLanguage::It,
            AppLanguage::Nl,
        ] {
            let lang_voices: Vec<_> = all.iter().filter(|v| v.language == lang.code()).collect();
            assert_eq!(lang_voices.len(), 27);
            assert_eq!(lang_voices[0].voice_id, lang.default_voice_id());
            assert!(lang_voices[0].is_native);
            assert_eq!(lang_voices.iter().filter(|v| v.is_native).count(), 1);
            assert!(lang_voices.iter().all(|v| v.engine == "pocket"));
        }

        assert!(
            pocket_voice_download_url(AppLanguage::Fr, "estelle")
                .unwrap()
                .ends_with("/languages/french/embeddings/estelle.safetensors")
        );

        assert_eq!(
            pick_downloaded_fallback_voice_for_lang(&paths, AppLanguage::De),
            "pocket:de:juergen"
        );
        let de_alba = paths.pocket_voice_path(AppLanguage::De, "alba").unwrap();
        std::fs::create_dir_all(de_alba.parent().unwrap()).unwrap();
        std::fs::write(&de_alba, b"kv").unwrap();
        assert_eq!(
            pick_downloaded_fallback_voice_for_lang(&paths, AppLanguage::De),
            "pocket:de:alba"
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
