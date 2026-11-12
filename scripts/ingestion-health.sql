-- Read-only operational queries, after the first deployment created the new tables.
-- Counts are collector attempts, not unique scheduled ticks or customer visits.
SELECT collector, date(started_at) day_utc, status, error_code,
       count(*) attempts, sum(rows_written) new_rows
FROM collector_runs
WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
GROUP BY collector,day_utc,status,error_code ORDER BY day_utc DESC,collector,status;

-- Running attempts left unfinished can indicate termination. Missing scheduled
-- runs have no row at all and must be compared to the configured schedule.
SELECT collector,run_id,scheduled_at,started_at,status,error_code
FROM collector_runs
WHERE status='running' AND started_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes');

-- Recent archive count and metadata coverage. Unknown historical provenance is
-- retained as missing; no source identifiers are inferred from price values.
SELECT p.symbol,count(*) observations,sum(CASE WHEN s.run_id IS NOT NULL THEN 1 ELSE 0 END) with_provenance,
       min(p.ts) first_ts,max(p.ts) latest_ts
FROM premium_snapshots p LEFT JOIN premium_snapshot_sources s ON p.ts=s.ts AND p.symbol=s.symbol
WHERE p.ts>=strftime('%s','now','-7 days')
GROUP BY p.symbol;

-- Optional DART pilot only: the latest fully paginated search date per company.
SELECT corp_code,covered_through_date,run_id FROM dart_collector_coverage ORDER BY corp_code;
