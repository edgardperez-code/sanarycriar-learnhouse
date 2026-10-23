"""Sanar y Criar: payments API (our own OSS module, mounted at /payments).

Auth levels used below:
- admin: org admin/maintainer (superadmin included) with a real session, and
  the ``payments`` feature enabled for the org.
- user: authenticated session (never an API token).
- public: anonymous allowed (the signed-in user is used when present).

Literal routes (``public-listing``, ``by-resource``, ``webhooks``...) are
declared before the parametric ones that could swallow them.
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlmodel.ext.asyncio.session import AsyncSession

from src.core.events.database import get_db_session
from src.db.users import AnonymousUser, APITokenUser, SuperadminAPITokenUser
from src.security.api_token_utils import get_authenticated_non_api_token_user
from src.security.auth import get_current_user
from src.services.payments import checkout as checkout_service
from src.services.payments import configs as configs_service
from src.services.payments import groups as groups_service
from src.services.payments import offers as offers_service
from src.services.payments import stats as stats_service
from src.services.payments.configs import PaymentConfigBody
from src.services.payments.groups import GroupBody
from src.services.payments.offers import OfferCreate, OfferUpdate

router = APIRouter()


# ------------------------------------------------------------ dependencies


async def _require_payments_feature(org_id: int, db_session: AsyncSession) -> None:
    from src.security.features_utils.dependencies import _check_feature_enabled

    await _check_feature_enabled("payments", org_id, db_session)


async def require_payments_admin(
    org_id: int,
    current_user=Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    if current_user is None or isinstance(current_user, AnonymousUser):
        raise HTTPException(status_code=401, detail="Authentication required")
    if isinstance(current_user, (APITokenUser, SuperadminAPITokenUser)):
        raise HTTPException(status_code=403, detail="API tokens cannot manage payments")
    from src.security.org_auth import require_org_admin
    from src.services.payments.common import get_org_or_404

    await get_org_or_404(db_session, org_id)
    await require_org_admin(current_user.id, org_id, db_session)
    await _require_payments_feature(org_id, db_session)
    return current_user


async def require_payments_enabled(
    org_id: int,
    db_session: AsyncSession = Depends(get_db_session),
) -> None:
    from src.services.payments.common import get_org_or_404

    await get_org_or_404(db_session, org_id)
    await _require_payments_feature(org_id, db_session)


def _check_rate(key: str, limit: int, window: int) -> None:
    """Soft rate limit; never fails closed when Redis is unavailable."""
    import os

    if os.getenv("TESTING", "false").lower() == "true":
        return
    try:
        from src.services.security.rate_limiting import check_rate_limit

        allowed, _, retry_after = check_rate_limit(key, limit, window)
    except Exception:
        return
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Demasiados intentos. Espera un momento e inténtalo de nuevo.",
            headers={"Retry-After": str(retry_after)},
        )


# --------------------------------------------------------------- webhooks


@router.post("/webhooks/{provider}/{org_id}", summary="Payment provider webhook")
async def api_provider_webhook(
    request: Request,
    provider: str,
    org_id: int,
    db_session: AsyncSession = Depends(get_db_session),
):
    """Signed provider notification (PayPal: postback verification)."""
    from src.services.security.rate_limiting import get_client_ip

    # Unauthenticated, and each request may cost a call to the provider:
    # cap it per client IP and per org before any verification. PayPal itself
    # sends a handful of events per sale, far below these limits.
    _check_rate(f"sc_pay_webhook:{get_client_ip(request)}", 120, 60)
    _check_rate(f"sc_pay_webhook_org:{org_id}", 600, 60)
    return await checkout_service.handle_provider_webhook(db_session, request, org_id, provider)


# ------------------------------------------------------------ configuration


@router.get("/{org_id}/config", summary="List payment provider configurations")
async def api_list_configs(
    request: Request,
    org_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await configs_service.list_configs(db_session, request, org_id)


@router.post("/{org_id}/config", summary="Create a payment provider configuration")
async def api_create_config(
    request: Request,
    org_id: int,
    body: Optional[PaymentConfigBody] = None,
    provider: Optional[str] = Query(default=None),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await configs_service.create_config(
        db_session, request, org_id, provider, body or PaymentConfigBody()
    )


@router.put("/{org_id}/config/{config_id}", summary="Update a payment provider configuration")
async def api_update_config(
    request: Request,
    org_id: int,
    config_id: int,
    body: PaymentConfigBody,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await configs_service.update_config(db_session, request, org_id, config_id, body)


@router.delete("/{org_id}/config", summary="Delete a payment provider configuration")
async def api_delete_config(
    org_id: int,
    id: int = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await configs_service.delete_config(db_session, org_id, id)


@router.get("/{org_id}/checkout/providers", summary="Active checkout providers (public)")
async def api_checkout_providers(
    org_id: int,
    _enabled=Depends(require_payments_enabled),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await configs_service.checkout_providers(db_session, org_id)


# ------------------------------------------------- offers: literal routes


@router.get("/{org_id}/offers", summary="List offers (admin)")
async def api_list_offers(
    org_id: int,
    include_archived: bool = False,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.list_offers(db_session, org_id, include_archived)


@router.post("/{org_id}/offers", summary="Create an offer")
async def api_create_offer(
    org_id: int,
    body: OfferCreate,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.create_offer(db_session, org_id, body)


@router.get("/{org_id}/offers/public-listing", summary="Public storefront offers")
async def api_public_listing(
    request: Request,
    org_id: int,
    _enabled=Depends(require_payments_enabled),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.public_listing(db_session, request, org_id)


@router.get("/{org_id}/offers/by-resource", summary="Offers covering a course (public)")
async def api_offers_by_resource(
    org_id: int,
    resource_uuid: str = Query(...),
    db_session: AsyncSession = Depends(get_db_session),
):
    from src.services.payments.common import get_org_or_404

    await get_org_or_404(db_session, org_id)
    return await offers_service.offers_by_resource(db_session, org_id, resource_uuid)


# ---------------------------------------------- offers: by id or by uuid


@router.get("/{org_id}/offers/{offer_ref}/public", summary="One public offer (id or uuid)")
async def api_public_offer(
    request: Request,
    org_id: int,
    offer_ref: str,
    _enabled=Depends(require_payments_enabled),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.public_offer(db_session, request, org_id, offer_ref)


@router.post("/{org_id}/offers/{offer_ref}/checkout", summary="Start a checkout for an offer")
async def api_offer_checkout(
    request: Request,
    org_id: int,
    offer_ref: str,
    redirect_uri: str = Query(...),
    provider: Optional[str] = Query(default=None),
    method: Optional[str] = Query(default="paypal"),
    _enabled=Depends(require_payments_enabled),
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    _check_rate(f"sc_pay_checkout:{user.id}", 20, 600)
    return await checkout_service.start_checkout(
        db_session, request, org_id, offer_ref, user,
        redirect_uri=redirect_uri, provider_id=provider, method=method,
    )


# ------------------------------------------------------ offers: admin by id


@router.get("/{org_id}/offers/{offer_id}", summary="One offer (admin)")
async def api_get_offer(
    org_id: int,
    offer_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.get_offer(db_session, org_id, offer_id)


@router.put("/{org_id}/offers/{offer_id}", summary="Update an offer (partial)")
async def api_update_offer(
    org_id: int,
    offer_id: int,
    body: OfferUpdate,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.update_offer(db_session, org_id, offer_id, body)


@router.delete("/{org_id}/offers/{offer_id}", summary="Archive an offer")
async def api_archive_offer(
    org_id: int,
    offer_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    # The dashboard checks for exactly HTTP 200.
    return await offers_service.archive_offer(db_session, org_id, offer_id)


@router.get("/{org_id}/offers/{offer_id}/resources", summary="Courses linked to an offer")
async def api_list_offer_resources(
    org_id: int,
    offer_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.list_offer_resources(db_session, org_id, offer_id)


@router.post("/{org_id}/offers/{offer_id}/resources", summary="Link a course to an offer")
async def api_add_offer_resource(
    org_id: int,
    offer_id: int,
    resource_uuid: str = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.add_offer_resource(db_session, org_id, offer_id, resource_uuid)


@router.delete("/{org_id}/offers/{offer_id}/resources", summary="Unlink a course from an offer")
async def api_remove_offer_resource(
    org_id: int,
    offer_id: int,
    resource_uuid: str = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await offers_service.remove_offer_resource(db_session, org_id, offer_id, resource_uuid)


# ------------------------------------------------------------------ groups


@router.get("/{org_id}/groups", summary="List payment groups")
async def api_list_groups(
    org_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.list_groups(db_session, org_id)


@router.post("/{org_id}/groups", summary="Create a payment group")
async def api_create_group(
    org_id: int,
    body: GroupBody,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.create_group(db_session, org_id, body)


@router.put("/{org_id}/groups/{group_id}", summary="Update a payment group")
async def api_update_group(
    org_id: int,
    group_id: int,
    body: GroupBody,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.update_group(db_session, org_id, group_id, body)


@router.delete("/{org_id}/groups/{group_id}", summary="Delete a payment group")
async def api_delete_group(
    org_id: int,
    group_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.delete_group(db_session, org_id, group_id)


@router.get("/{org_id}/groups/{group_id}/resources", summary="Courses in a payment group")
async def api_list_group_resources(
    org_id: int,
    group_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.list_group_resources(db_session, org_id, group_id)


@router.post("/{org_id}/groups/{group_id}/resources", summary="Add a course to a payment group")
async def api_add_group_resource(
    org_id: int,
    group_id: int,
    resource_uuid: str = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.add_group_resource(db_session, org_id, group_id, resource_uuid)


@router.delete("/{org_id}/groups/{group_id}/resources", summary="Remove a course from a payment group")
async def api_remove_group_resource(
    org_id: int,
    group_id: int,
    resource_uuid: str = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.remove_group_resource(db_session, org_id, group_id, resource_uuid)


@router.get("/{org_id}/groups/{group_id}/sync", summary="Usergroups synced to a payment group")
async def api_list_group_syncs(
    org_id: int,
    group_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.list_group_syncs(db_session, org_id, group_id)


@router.post("/{org_id}/groups/{group_id}/sync", summary="Sync a usergroup to a payment group")
async def api_add_group_sync(
    org_id: int,
    group_id: int,
    usergroup_id: int = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.add_group_sync(db_session, org_id, group_id, usergroup_id)


@router.delete("/{org_id}/groups/{group_id}/sync", summary="Stop syncing a usergroup")
async def api_remove_group_sync(
    org_id: int,
    group_id: int,
    usergroup_id: int = Query(...),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await groups_service.remove_group_sync(db_session, org_id, group_id, usergroup_id)


# ------------------------------------------------- customers and analytics


@router.get("/{org_id}/customers", summary="Buyers and their purchases (admin)")
async def api_customers(
    org_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.list_customers(db_session, org_id)


@router.get("/{org_id}/enrollments/mine", summary="The current user's purchases")
async def api_my_enrollments(
    request: Request,
    org_id: int,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.my_enrollments(db_session, request, org_id, user)


@router.get("/{org_id}/overview", summary="Sales overview (admin)")
async def api_overview(
    org_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.overview(db_session, org_id)


@router.get("/{org_id}/transactions", summary="Charges, newest first (admin)")
async def api_transactions(
    org_id: int,
    limit: int = Query(default=25, ge=1, le=100),
    starting_after: Optional[str] = Query(default=None),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.transactions(db_session, org_id, limit, starting_after)


# Aliases kept for the dashboard screens written against the Stripe shape.
@router.get("/{org_id}/stripe/overview", include_in_schema=False)
async def api_stripe_overview_alias(
    org_id: int,
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.overview(db_session, org_id)


@router.get("/{org_id}/stripe/charges", include_in_schema=False)
async def api_stripe_charges_alias(
    org_id: int,
    limit: int = Query(default=25, ge=1, le=100),
    starting_after: Optional[str] = Query(default=None),
    _admin=Depends(require_payments_admin),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await stats_service.transactions(db_session, org_id, limit, starting_after)


@router.get("/{org_id}/stripe/subscriptions", include_in_schema=False)
async def api_stripe_subscriptions_alias(
    org_id: int,
    status: Optional[str] = None,
    _admin=Depends(require_payments_admin),
):
    # One-time purchases only for now.
    return {"data": []}


@router.post("/{org_id}/billing/portal", summary="Customer billing portal (not available)")
async def api_billing_portal(org_id: int):
    raise HTTPException(status_code=404, detail="No billing portal for this provider")


# ------------------------------------------------------------------ orders


@router.post("/{org_id}/orders/{order_uuid}/capture", summary="Confirm a returning checkout")
async def api_capture_order(
    request: Request,
    org_id: int,
    order_uuid: str,
    user=Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    # The unguessable order uuid is the credential here (the buyer may come
    # back from PayPal with an expired session); see the service for checks.
    return await checkout_service.capture_order_endpoint(db_session, request, org_id, order_uuid, user)


@router.get("/{org_id}/orders/{order_uuid}", summary="Order status (owner or admin)")
async def api_get_order(
    request: Request,
    org_id: int,
    order_uuid: str,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await checkout_service.get_order_status(db_session, request, org_id, order_uuid, user)


@router.post("/{org_id}/orders/{order_uuid}/cancel", summary="Cancel an unpaid order")
async def api_cancel_order(
    request: Request,
    org_id: int,
    order_uuid: str,
    user=Depends(get_authenticated_non_api_token_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await checkout_service.cancel_order_endpoint(db_session, request, org_id, order_uuid, user)


# ------------------------------------------------------------------ access


@router.get("/{org_id}/access", summary="Whether the caller may consume a course")
async def api_course_access(
    org_id: int,
    resource_uuid: str = Query(...),
    user=Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db_session),
):
    return await checkout_service.course_access(db_session, org_id, resource_uuid, user)
