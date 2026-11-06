"""
Password validation service.

Sanar y Criar (2026-11): the client asked for a simple rule so mothers can
sign up from the phone without friction:
- At least 6 characters
- At least 1 letter (any alphabet, accents and ñ included)
- At least 1 number (0-9)

The same rule applies everywhere a password is set (sign-up, invite sign-up,
reset, change, admin-created users). Keep it in sync with
apps/web/components/Auth/PasswordStrengthIndicator.tsx.
"""
import re
from typing import List
from pydantic import BaseModel


MIN_PASSWORD_LENGTH = 6


class PasswordValidationResult(BaseModel):
    """Result of password validation."""
    is_valid: bool
    errors: List[str]
    requirements: dict


def validate_password_complexity(password: str) -> PasswordValidationResult:
    """
    Validate password against the requirements above.

    Returns:
        PasswordValidationResult with validation status and any errors
    """
    errors: List[str] = []
    password = password or ""

    requirements = {
        "min_length": len(password) >= MIN_PASSWORD_LENGTH,
        "has_letter": any(char.isalpha() for char in password),
        "has_number": re.search(r"[0-9]", password) is not None,
    }

    if not requirements["min_length"]:
        errors.append(f"Password must be at least {MIN_PASSWORD_LENGTH} characters long")
    if not requirements["has_letter"]:
        errors.append("Password must contain at least one letter")
    if not requirements["has_number"]:
        errors.append("Password must contain at least one number")

    return PasswordValidationResult(
        is_valid=all(requirements.values()),
        errors=errors,
        requirements=requirements,
    )


def get_password_requirements() -> List[dict]:
    """
    Get list of password requirements for display purposes.

    Returns:
        List of requirement descriptions
    """
    return [
        {"id": "min_length", "description": f"At least {MIN_PASSWORD_LENGTH} characters"},
        {"id": "has_letter", "description": "At least one letter"},
        {"id": "has_number", "description": "At least one number (0-9)"},
    ]
