-- ============================================================================
-- Remove any saved Complete Medical Supplies commission-report template mapping.
-- Commission templates are stored in app_settings under keys like
-- 'ctpl:<manufacturer-slug>'. This removes the Complete Medical one if it exists
-- (no error if it never was created). The in-code import mapping is removed in
-- src/admin/dealers.html. Historical commission/sales rows are left untouched.
-- Safe to re-run.
-- ============================================================================
delete from app_settings where key ilike 'ctpl:complete-medical%';
