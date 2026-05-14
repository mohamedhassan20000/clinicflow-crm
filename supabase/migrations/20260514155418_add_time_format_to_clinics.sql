ALTER TABLE clinics
  ADD COLUMN IF NOT EXISTS time_format VARCHAR(3) NOT NULL DEFAULT '24h'
  CHECK (time_format IN ('12h', '24h'));;
