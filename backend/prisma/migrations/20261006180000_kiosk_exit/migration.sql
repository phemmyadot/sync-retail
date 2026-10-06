-- Kiosk mode: manager unlock is recorded like other overrides.
ALTER TYPE "OverrideAction" ADD VALUE IF NOT EXISTS 'KIOSK_EXIT';
