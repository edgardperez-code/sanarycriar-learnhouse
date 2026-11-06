from src.services.security.password_validation import (
    get_password_requirements,
    validate_password_complexity,
)


def test_accepts_simple_password_with_letters_and_numbers():
    for password in ("hilda1", "abc123", "123abc", "Mamá2025", "niño12", "Strong1!"):
        result = validate_password_complexity(password)
        assert result.is_valid is True, password
        assert result.errors == []
        assert all(result.requirements.values())


def test_reports_all_missing_requirements():
    result = validate_password_complexity("!!!")

    assert result.is_valid is False
    assert result.requirements == {
        "min_length": False,
        "has_letter": False,
        "has_number": False,
    }
    assert result.errors == [
        "Password must be at least 6 characters long",
        "Password must contain at least one letter",
        "Password must contain at least one number",
    ]


def test_rejects_too_short():
    result = validate_password_complexity("ab12")
    assert result.is_valid is False
    assert result.requirements == {"min_length": False, "has_letter": True, "has_number": True}


def test_rejects_only_digits():
    result = validate_password_complexity("123456")
    assert result.is_valid is False
    assert result.errors == ["Password must contain at least one letter"]


def test_rejects_only_letters():
    result = validate_password_complexity("abcdef")
    assert result.is_valid is False
    assert result.errors == ["Password must contain at least one number"]


def test_handles_empty_password():
    result = validate_password_complexity("")
    assert result.is_valid is False
    assert not any(result.requirements.values())


def test_get_password_requirements_returns_expected_items():
    requirements = get_password_requirements()

    assert [item["id"] for item in requirements] == [
        "min_length",
        "has_letter",
        "has_number",
    ]
    assert requirements[0]["description"] == "At least 6 characters"
