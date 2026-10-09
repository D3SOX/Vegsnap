ALTER TABLE submissions ADD COLUMN coverage_json TEXT;
ALTER TABLE submissions ADD COLUMN match_rules_json TEXT NOT NULL DEFAULT '[]';
UPDATE submissions SET match_rules_json = json_array(
  json_object('market', market, 'kind', 'barcode', 'key', barcode, 'barcode', barcode),
  json_object('market', market, 'kind', 'name', 'key', json_array(name_key, brand_key), 'barcode', barcode)
);
