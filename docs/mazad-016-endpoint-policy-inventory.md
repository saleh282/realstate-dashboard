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
| `GET /broker/requirements`, own applications/documents | Authenticated professional self read | `BROKER_APPLICATION_READ_OWN` plus applicant predicate for private evidence |
| `POST /broker/applications` | Professional mutation | `BROKER_APPLICATION_SUBMIT`: ACTIVE USER with eligible broker state |

