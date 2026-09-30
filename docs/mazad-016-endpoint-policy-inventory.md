# MAZAD-016 protected endpoint policy inventory

This inventory freezes the V1 authorization classification. Capability responses are UI hints only; every command is re-evaluated from the current database-backed request principal and resource state.

| Route group | Classification | Enforced capability / rule |
| --- | --- | --- |
| `POST /auth/register`, login, email verification/recovery | Public authentication | Auth service validation and throttling |
| `POST /auth/refresh` | Session refresh | Server-side refresh-session state |
| `POST /auth/logout`, `POST /auth/logout-all` | Authenticated session command | Current JWT/session; no marketplace authority |
| `GET /users/me`, `/users/profile`, `/users/me/capabilities` | Authenticated self read | `ACCOUNT_SELF_READ` |
| `PATCH /users/me`, password, delete | Authenticated self management | `ACCOUNT_SELF_MANAGE` |
| `GET /kyc/status` | Marketplace-account self read | `KYC_SELF_READ`; trust state is not a marketplace gate |
| `POST /kyc/submit` | Marketplace-account trust submission | `KYC_SELF_SUBMIT`; trust state is not a marketplace gate |
| Public catalog/property lists | Public | Active catalog or approved/public property filter |
| `POST /properties` | Marketplace mutation | `PROPERTY_CREATE`, ACTIVE account, staff forbidden, approved BROKER state when advertising as BROKER |
| `GET /properties/mine*` | Owner/resource-scoped read | `PROPERTY_READ_OWN` plus advertiser-account predicate; unknown/foreign IDs return not found |
| `PATCH /properties/mine/:id/visibility` | Owner/resource-scoped mutation | `PROPERTY_MANAGE_OWN`, ACTIVE account, advertiser-account predicate |
| `GET /broker/requirements`, own applications/documents | Authenticated professional self read | `BROKER_APPLICATION_READ_OWN` plus applicant predicate for private evidence |
| `POST /broker/applications` | Professional mutation | `BROKER_APPLICATION_SUBMIT`: ACTIVE USER with eligible broker state |
| `/admin/companies` | Admin-only | `COMPANY_CREATE`; service creates only USER-role COMPANY principals |
| `/admin/users` reads | Admin-only | `ADMIN_ACCOUNT_READ` |
| Admin user status/session/delete | Admin-only target-scoped mutation | `ADMIN_ACCOUNT_MANAGE` plus target-governance rules |
| Admin role update | SUPER_ADMIN-only | `SUPER_ADMIN_ROLE_MANAGE`; product cannot create/promote SUPER_ADMIN |
| `/admin/kyc*` | Admin review | `ADMIN_KYC_REVIEW` plus private-evidence delivery checks |
| `/admin/properties*` | Admin review/proxy | `ADMIN_PROPERTY_REVIEW`; proxy creation overrides with `ADMIN_PROPERTY_PROXY_CREATE` and validates target account |
| `/admin/broker*`, broker requirements | Admin review | `ADMIN_BROKER_REVIEW`; optimistic state/version transitions remain authoritative |
| Admin catalog endpoints | Admin-only | `ADMIN_CATALOG_MANAGE` |
| `/admin/property-attributes` (read), `/admin/property-form-definitions` reads, definition creation, draft open/save/validate/diff/discard | Admin-only | `ADMIN_CATALOG_MANAGE`; draft commands carry `expectedVersion` / `expectedDraftRevision` |
| `/admin/property-form-definitions/:id/publish`, `/archive`, `/restore` | SUPER_ADMIN-only | `ADMIN_FORM_DEFINITION_PUBLISH` (DPF-030); optimistic tokens and one audited transaction |
| `/admin/audit-logs` | Admin-only read | `ADMIN_AUDIT_READ` |
| `/admin/dashboard/metrics` | Admin-only read | `ADMIN_DASHBOARD_READ` |
| `/admin/operations/status` | Admin-only read (Phase 13 operator diagnostics) | `ADMIN_DASHBOARD_READ` |

| `POST /auctions` | Retired (MAZAD-035) | `AUCTION_CREATE_OWN` guard, then always `409 AUCTION_REVIEW_REQUIRED`; auctions are created only by Admin approval |
| `POST /auction-requests` | Marketplace mutation (MAZAD-035) | `AUCTION_CREATE_OWN` + own-property predicate; submits directly to `pending_review` |
| `GET /auction-requests/mine*`, `/auction-requests/eligible-properties` | Owner/resource-scoped read | `AUCTION_READ_OWN` plus advertiser predicate; foreign ids return not found |
| `PATCH /auction-requests/mine/:id`, `POST …/resubmit`, `POST …/withdraw` | Owner/resource-scoped mutation | `AUCTION_MANAGE_OWN`, ACTIVE account, advertiser predicate, `expectedRevision` |
| `GET /auctions/mine*`, `POST /auctions/mine/:id/cancel` | Owner/resource-scoped | `AUCTION_READ_OWN` / `AUCTION_MANAGE_OWN` plus advertiser predicate |
| `/admin/auction-requests` reads | Admin-only read | `ADMIN_AUCTION_READ` |
| `POST /admin/auction-requests/:id/review` | Admin review (ADMIN and SUPER_ADMIN) | `ADMIN_AUCTION_REVIEW`; approve sets the entry fee (0 = FREE), `expectedRevision` |
| `/admin/auctions` reads (incl. `/:id/bids` staff ledger) | Admin-only read | `ADMIN_AUCTION_READ` |
| `POST /admin/auctions/:id/cancel` | Admin mutation (ADMIN and SUPER_ADMIN) | `ADMIN_AUCTION_CANCEL`; structured reason code, `expectedStatus` |

Bid and entry-payment routes use `BID_PLACE` and `PAYMENT_ENTRY_INITIATE`; `assertBid` also enforces exact-account self-bid prevention. `ADMIN_AUCTION_FEE_MANAGE` remains only for the legacy internal fee path (no route).
