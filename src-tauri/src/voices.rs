//! Complete English voice catalog (37 voices) from `gradium/phonon-voices`.

use crate::models::VoiceInfo;
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

pub fn find_voice(voice_id: &str) -> Option<&'static CatalogEntry> {
    EN_VOICES.iter().find(|v| v.voice_id == voice_id)
}

pub fn voice_download_url(voice_id: &str) -> String {
    format!(
        "https://huggingface.co/gradium/phonon-voices/resolve/main/voices/{voice_id}.safetensors"
    )
}

pub fn list_voices_with_status(paths: &AppPaths) -> Vec<VoiceInfo> {
    EN_VOICES
        .iter()
        .map(|v| VoiceInfo {
            voice_id: v.voice_id.to_string(),
            name: v.name.to_string(),
            locale: v.locale.to_string(),
            gender: v.gender.to_string(),
            age: v.age.to_string(),
            description: v.description.to_string(),
            downloaded: paths.is_voice_downloaded(v.voice_id),
        })
        .collect()
}
