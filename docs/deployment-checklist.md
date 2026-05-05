# Deployment Checklist

## Database

- Before deploying the current code, apply Phase 5 migrations to Supabase production DB, especially the RPC `clear_own_must_change_password()`.
- Apply migrations in timestamp order and verify RLS policies after deployment.
- Confirm forced password change still clears `must_change_password` through `clear_own_must_change_password()`.
- Confirm doctors can only read their assigned or department-scoped patients and appointments.
