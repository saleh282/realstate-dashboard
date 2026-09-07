# Real Estate Auction Backend — Auth + KYC (منصة مزادات العقار)

NestJS + MongoDB backend covering the 6 screens: login, forgot password, OTP
verification, reset password, register, and national-ID KYC.

## Setup

```bash
npm install
cp .env.example .env   # fill in Mongo URI, JWT secrets, Cloudinary, SMTP
npm run start:dev
```

All routes are prefixed with `/api/v1`.

## Flow → Endpoint map

| Screen | Endpoint |
|---|---|
| 1. تسجيل الدخول (Login) | `POST /auth/login` |
| 4. نسيت كلمة المرور (Forgot password) | `POST /auth/forgot-password` |
| 3. رمز التحقق (OTP) | `POST /auth/verify-otp` |
| 2. تعيين كلمة مرور جديدة (Reset password) | `POST /auth/reset-password` |
| 5. إنشاء حساب جديد, step 1 (Register) | `POST /auth/register` |
| 6. التحقق من الهوية KYC, step 2 | `POST /kyc/submit` (multipart) |

## Auth endpoints

### `POST /auth/register`
```json
{ "fullName": "...", "identifier": "email or 05xxxxxxxx", "password": "...", "confirmPassword": "..." }
```
→ `{ accessToken, refreshToken }`. Frontend should proceed straight to the KYC screen after this.

### `POST /auth/login`
```json
{ "identifier": "...", "password": "...", "rememberMe": true }
```
→ `{ accessToken, refreshToken, user }`

### `POST /auth/forgot-password`
```json
{ "identifier": "..." }
```
Sends a 6-digit OTP by email or SMS depending on which was registered. Always returns a generic success message (doesn't reveal if the account exists).

### `POST /auth/resend-otp`
Same body as forgot-password. Blocked by a cooldown (`OTP_RESEND_SECONDS`, default 60s — matches the countdown on the OTP screen).

### `POST /auth/verify-otp`
```json
{ "identifier": "...", "otp": "123456" }
```
→ `{ resetToken }` — a short-lived (10 min) token used only for the next call.

### `POST /auth/reset-password`
```json
{ "resetToken": "...", "newPassword": "...", "confirmPassword": "..." }
```

### `POST /auth/refresh`
```json
{ "refreshToken": "..." }
```

### `POST /auth/logout`
Requires `Authorization: Bearer <accessToken>`.

## KYC endpoints (require `Authorization: Bearer <accessToken>`)

### `POST /kyc/submit`
`multipart/form-data` with three file fields: `idFront`, `idBack`, `selfie` (max 5MB each). Uploads to Cloudinary and sets `kycStatus` to `pending`.

### `GET /kyc/status`
→ `{ kycStatus, kycSubmittedAt, kycReviewedAt, kycRejectionReason }`
`kycStatus` is one of `not_submitted | pending | verified | rejected`.

### `POST /kyc/review/:userId`
Back-office endpoint to approve/reject — **add an admin-role guard before shipping this**, it currently only requires being logged in.
```json
{ "decision": "verified" | "rejected", "rejectionReason": "..." }
```

## Notes

- The identifier field (email or phone) is auto-detected everywhere via regex — same behavior as the app's combined input.
- SMS sending is a stub (`sms.service.ts`) — wire up Unifonic/Msegat/Twilio for real phone OTP delivery.
- Password reset uses a two-step token handoff (OTP → resetToken → new password) so the OTP can't be replayed.
- Rate limiting: `forgot-password` and `resend-otp` are throttled to 3 requests/min per IP on top of the per-user resend cooldown.
