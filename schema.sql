-- Run on the server:
-- docker exec -i supabase-db psql -U postgres -d postgres < schema.sql

CREATE TABLE IF NOT EXISTS counters (
  prefix TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploaded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publish_checklist JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS card_identities (
  id TEXT PRIMARY KEY,
  sport TEXT,
  player_name TEXT,
  year INTEGER,
  set_name TEXT,
  card_number TEXT,
  parallel TEXT,
  base_hint BOOLEAN DEFAULT FALSE,
  rookie_flag BOOLEAN DEFAULT FALSE,
  autograph_flag BOOLEAN DEFAULT FALSE,
  variant_label TEXT,
  grade TEXT,
  graded_flag BOOLEAN DEFAULT FALSE,
  serial_number TEXT,
  print_run INTEGER,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS card_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new',
  confidence_score REAL DEFAULT 0,
  recommended_price REAL,
  currency TEXT DEFAULT 'USD',
  is_thick_card BOOLEAN DEFAULT FALSE,
  candidate_base_hint BOOLEAN DEFAULT FALSE,
  candidate_auto_hint BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publish_state TEXT DEFAULT 'draft',
  front_image_id TEXT,
  back_image_id TEXT,
  notes TEXT DEFAULT '',
  sku TEXT,
  candidate_parallel TEXT,
  print_run INTEGER,
  serial_number TEXT,
  candidate_player TEXT,
  candidate_year INTEGER,
  candidate_set_name TEXT,
  candidate_card_number TEXT,
  candidate_grade TEXT,
  candidate_condition TEXT DEFAULT 'raw',
  candidate_rookie_flag BOOLEAN DEFAULT FALSE,
  candidate_variant_label TEXT,
  canonical_card_id TEXT,
  -- legacy direct fields (coexist with candidate_* fields above)
  base_hint BOOLEAN DEFAULT FALSE,
  thick_card BOOLEAN DEFAULT FALSE,
  player_name TEXT,
  year INTEGER,
  set_name TEXT,
  card_number TEXT,
  parallel TEXT,
  grade TEXT,
  rookie_mode TEXT,
  pricing_strategy TEXT,
  pricing_confidence TEXT,
  pricing_reason TEXT,
  pricing_evidence JSONB DEFAULT '{}'::jsonb,
  market_data_source TEXT,
  ocr_provider TEXT,
  ocr_notes TEXT,
  excluded_comp_ids JSONB DEFAULT '[]'::jsonb,
  external_sold_comps JSONB DEFAULT '[]'::jsonb,
  external_comp_source TEXT,
  external_comp_updated_at TIMESTAMPTZ,
  apify_lookup_key TEXT,
  apify_search_keywords JSONB DEFAULT '[]'::jsonb,
  apify_search_query TEXT,
  apify_error TEXT
);

CREATE TABLE IF NOT EXISTS card_images (
  id TEXT PRIMARY KEY,
  card_item_id TEXT NOT NULL REFERENCES card_items(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  storage_path TEXT,
  url TEXT,
  byte_length INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ocr_text TEXT
);

CREATE TABLE IF NOT EXISTS comps (
  id TEXT PRIMARY KEY,
  card_item_id TEXT NOT NULL REFERENCES card_items(id) ON DELETE CASCADE,
  source TEXT,
  listing_id TEXT,
  title TEXT,
  condition_label TEXT,
  sale_price REAL,
  shipping_price REAL,
  total_price REAL,
  sold_at TIMESTAMPTZ,
  url TEXT,
  match_score REAL,
  raw_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  card_item_id TEXT NOT NULL REFERENCES card_items(id) ON DELETE CASCADE,
  ebay_offer_id TEXT,
  inventory_item_id TEXT,
  sku TEXT,
  price REAL,
  quantity INTEGER DEFAULT 1,
  is_thick_card BOOLEAN DEFAULT FALSE,
  status TEXT,
  listing_url TEXT,
  request_payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'app',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cardhedge_cache (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  cache_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_card_items_batch_id ON card_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_card_items_status ON card_items(status);
CREATE INDEX IF NOT EXISTS idx_card_images_card_item_id ON card_images(card_item_id);
CREATE INDEX IF NOT EXISTS idx_comps_card_item_id ON comps(card_item_id);
CREATE INDEX IF NOT EXISTS idx_offers_card_item_id ON offers(card_item_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_cardhedge_cache_type ON cardhedge_cache(cache_type);
CREATE INDEX IF NOT EXISTS idx_cardhedge_cache_expires_at ON cardhedge_cache(expires_at);
