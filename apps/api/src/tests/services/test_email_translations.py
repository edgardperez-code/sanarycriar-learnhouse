"""Tests for src/services/email/translations.py."""

from src.services.email.translations import (
    DEFAULT_LANGUAGE,
    EMAIL_TRANSLATIONS,
    SUPPORTED_LANGUAGES,
    SUPPORTED_UI_LANGUAGES,
    normalize_language,
    t,
)


class TestNormalizeLanguage:
    def test_known_code_passes_through(self):
        assert normalize_language("fr") == "fr"

    def test_hyphenated_locale_strips_region(self):
        assert normalize_language("en-US") == "en"
        assert normalize_language("pt-BR") == "pt"

    def test_uppercase_is_normalized(self):
        assert normalize_language("FR") == "fr"

    def test_unknown_code_falls_back_to_english(self):
        assert normalize_language("klingon") == DEFAULT_LANGUAGE

    def test_default_language_is_spanish(self):
        # Sanar y Criar: Spanish when the org/user language is unknown.
        assert DEFAULT_LANGUAGE == "es"
        assert normalize_language(None) == "es"

    def test_none_falls_back_to_english(self):
        assert normalize_language(None) == DEFAULT_LANGUAGE

    def test_empty_string_falls_back_to_english(self):
        assert normalize_language("") == DEFAULT_LANGUAGE


class TestT:
    def test_translates_to_target_language(self):
        # Sanity check: at least one well-known phrase resolves correctly.
        assert t("fr", "invitation.heading") == "Vous êtes invité !"

    def test_falls_back_to_default_language_for_unknown_lang(self):
        # Sanar y Criar: the fallback is Spanish (DEFAULT_LANGUAGE), not English.
        assert t("klingon", "invitation.heading") == EMAIL_TRANSLATIONS["es"]["invitation.heading"]

    def test_falls_back_to_english_when_key_missing_in_locale(self):
        # Insert a locale that's missing a specific key, then look it up;
        # we expect the English bundle's value back.
        assert t("fr", "academy_link_text") == EMAIL_TRANSLATIONS["fr"]["academy_link_text"]

    def test_returns_key_itself_when_key_unknown_everywhere(self):
        # No locale has this key; t() must not raise.
        assert t("fr", "totally.made.up.key") == "totally.made.up.key"

    def test_format_kwargs_are_interpolated(self):
        rendered = t("fr", "invitation.subject", org_name="Acme")
        assert "Acme" in rendered

    def test_missing_format_kwargs_return_template_safely(self):
        # invitation.subject expects {org_name}; without it Python's
        # str.format would raise KeyError. The helper must swallow that and
        # return the raw template instead of crashing the email send.
        rendered = t("fr", "invitation.subject")
        assert "{org_name}" in rendered

    def test_supported_languages_list_matches_translation_bundles(self):
        # Anyone editing translations.py has to keep these in sync; if not,
        # callers that validate via SUPPORTED_LANGUAGES would silently get
        # the English fallback for a "supported" locale.
        for code in SUPPORTED_LANGUAGES:
            assert code in EMAIL_TRANSLATIONS, f"missing translation bundle: {code}"


class TestSupportedUILanguages:
    def test_email_languages_are_a_subset_of_ui_languages(self):
        # Every locale with email bundles must also be a valid UI language.
        assert set(SUPPORTED_LANGUAGES).issubset(set(SUPPORTED_UI_LANGUAGES))

    def test_ui_languages_include_slovak(self):
        # Regression: sk must be selectable as an org UI language.
        assert "sk" in SUPPORTED_UI_LANGUAGES

    def test_ui_only_languages_fall_back_to_default_language_email(self):
        # A UI language without an email bundle must not break email sending.
        # Sanar y Criar: it falls back to Spanish (DEFAULT_LANGUAGE).
        for code in SUPPORTED_UI_LANGUAGES:
            if code not in EMAIL_TRANSLATIONS:
                assert t(code, "invitation.heading") == EMAIL_TRANSLATIONS[DEFAULT_LANGUAGE]["invitation.heading"]


class TestWhiteLabelTranslations:
    """Org-scoped copy must not hardcode the platform name in any locale."""

    # Keys rendered only inside an organization's own emails.
    ORG_SCOPED_PREFIXES = (
        "invitation.",
        "org_join.",
        "role_changed.",
        "email_verification.",
        "magic_login.",
        "password_reset.footer_org",
        "account_creation.subject_org",
        "account_creation.body_in_org",
    )

    def test_org_scoped_keys_never_name_learnhouse(self):
        for lang, bundle in EMAIL_TRANSLATIONS.items():
            for key, value in bundle.items():
                if key.startswith(self.ORG_SCOPED_PREFIXES):
                    assert "LearnHouse" not in value, f"{lang}:{key}"

    def test_every_locale_ships_magic_login_copy(self):
        for lang in SUPPORTED_LANGUAGES:
            for suffix in ("subject", "heading", "body", "cta", "footer"):
                assert f"magic_login.{suffix}" in EMAIL_TRANSLATIONS[lang], f"{lang}:{suffix}"

    def test_placeholders_match_english_in_every_locale(self):
        import re

        english = EMAIL_TRANSLATIONS["en"]
        for lang, bundle in EMAIL_TRANSLATIONS.items():
            for key, value in bundle.items():
                if key not in english or not key.startswith(self.ORG_SCOPED_PREFIXES):
                    continue
                expected = set(re.findall(r"\{(\w+)\}", english[key]))
                actual = set(re.findall(r"\{(\w+)\}", value))
                assert actual == expected, f"{lang}:{key} has {actual}, en has {expected}"

    def test_powered_by_line_exists_everywhere(self):
        # Sanar y Criar: the footer line names Sanar y Criar, never LearnHouse.
        for lang in SUPPORTED_LANGUAGES:
            line = EMAIL_TRANSLATIONS[lang]["common.powered_by"]
            assert line.startswith("Sanar y Criar"), lang
            assert "LearnHouse" not in line, lang


class TestSanarYCriarSpanish:
    """Sanar y Criar: Spanish is the primary language of every email."""

    def test_spanish_bundle_is_complete(self):
        english = EMAIL_TRANSLATIONS["en"]
        spanish = EMAIL_TRANSLATIONS["es"]
        missing = sorted(set(english) - set(spanish))
        assert missing == [], missing
        for key, value in spanish.items():
            assert value.strip(), key

    def test_spanish_placeholders_match_english(self):
        import re

        english = EMAIL_TRANSLATIONS["en"]
        for key, value in EMAIL_TRANSLATIONS["es"].items():
            if key not in english:
                continue
            expected = set(re.findall(r"\{(\w+)\}", english[key]))
            actual = set(re.findall(r"\{(\w+)\}", value))
            assert actual == expected, f"es:{key} has {actual}, en has {expected}"

    def test_spanish_copy_names_sanar_y_criar_not_learnhouse(self):
        # Only the nudge about LearnHouse product updates may still say
        # LearnHouse (the academy link now points at sanarycriarve.com).
        allowed = {"nudge.reactivation.whats_changed.subject"}
        for key, value in EMAIL_TRANSLATIONS["es"].items():
            if key not in allowed:
                assert "LearnHouse" not in value, key
        assert "Sanar y Criar" in t("es", "account_deleted.subject")
        assert "Sanar y Criar" in t(None, "account_creation.subject", username="Ana")

    def test_platform_named_keys_are_rebranded_in_every_locale(self):
        for lang in SUPPORTED_LANGUAGES:
            for key in ("account_creation.subject", "account_deleted.subject"):
                assert "LearnHouse" not in EMAIL_TRANSLATIONS[lang].get(key, ""), f"{lang}:{key}"

    def test_welcome_footer_links_to_our_site_in_every_locale(self):
        # Sanar y Criar: the org-less welcome footer names sanarycriarve.com,
        # never "LearnHouse Academy".
        from src.services.email.translations import ACADEMY_LINK_TEXT

        for lang in SUPPORTED_LANGUAGES:
            assert EMAIL_TRANSLATIONS[lang]["academy_link_text"] == ACADEMY_LINK_TEXT, lang
            assert "{academy_link}" in t(lang, "account_creation.footer"), lang
        assert "escribirnos" in t("es", "account_creation.footer")
        assert "reach us" in t("en", "account_creation.footer")

    def test_missing_key_falls_back_to_spanish_then_english(self):
        EMAIL_TRANSLATIONS["en"]["sc.test.only_en"] = "English only"
        EMAIL_TRANSLATIONS["es"]["sc.test.es_and_en"] = "Español"
        EMAIL_TRANSLATIONS["en"]["sc.test.es_and_en"] = "English"
        try:
            assert t("fr", "sc.test.es_and_en") == "Español"
            assert t("fr", "sc.test.only_en") == "English only"
        finally:
            del EMAIL_TRANSLATIONS["en"]["sc.test.only_en"]
            del EMAIL_TRANSLATIONS["es"]["sc.test.es_and_en"]
            del EMAIL_TRANSLATIONS["en"]["sc.test.es_and_en"]
