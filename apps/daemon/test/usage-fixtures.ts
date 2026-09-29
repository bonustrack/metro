export const recordedClaudeUsageAnswer =
  '{"type":"control_response","response":{"subtype":"success","request_id":"metro-usage","response":{"session":{"total_cost_usd":0,"total_api_duration_ms":0,"total_duration_ms":993,"total_lines_added":0,"total_lines_removed":0,"model_usage":{}},"subscription_type":"max","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":11,"resets_at":"2026-09-29T13:49:59.999766+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"seven_day":{"utilization":70,"resets_at":"2026-09-30T23:59:59.999787+00:00","limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"seven_day_oauth_apps":null,"seven_day_opus":null,"seven_day_sonnet":null,"seven_day_cowork":null,"seven_day_omelette":null,"tangelo":null,"iguana_necktie":null,"omelette_promotional":null,"nimbus_quill":{"utilization":0,"resets_at":null,"limit_dollars":null,"used_dollars":null,"remaining_dollars":null,"locked_reason":null},"cinder_cove":null,"copper_kite":null,"brass_thimble":null,"harbor_lantern":null,"wattle_ember":null,"amber_ladder":null,"amber_cistern":null,"juniper_tide":null,"cedar_ember":null,"amber_gauge":null,"extra_usage":{"is_enabled":false,"monthly_limit":null,"used_credits":null,"utilization":null,"currency":null,"decimal_places":null,"disabled_reason":null,"user_disabled":true,"spend_limit_reached":false,"credits_ever_enabled":true,"daily":null,"weekly":null},"limits":[{"kind":"session","group":"session","percent":11,"severity":"normal","resets_at":"2026-09-29T13:49:59.999766+00:00","scope":null,"is_active":false},{"kind":"weekly_all","group":"weekly","percent":70,"severity":"normal","resets_at":"2026-09-30T23:59:59.999787+00:00","scope":null,"is_active":true},{"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal","resets_at":"2026-10-01T00:00:00+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":false}],"spend":{"used":{"amount_minor":0,"currency":"USD","exponent":2},"limit":null,"percent":0,"severity":"normal","enabled":false,"disabled_reason":null,"cap":null,"balance":null,"auto_reload":null,"disclaimer":"Usage credits cover you when you hit your plan limits. [Learn more](https://support.claude.com/articles/12429409)","can_purchase_credits":false,"can_toggle":false},"member_dashboard_available":false,"seven_day_breakdown":{"as_of":"2026-09-29T13:32:52.038891+00:00","window_started_at":"2026-09-23T23:59:59.999787+00:00","rows":[{"key":"claude_code","display_name":"Claude Code","percent":99},{"key":"chat","display_name":"Chats","percent":1},{"key":"cowork","display_name":"Cowork","percent":0},{"key":"other","display_name":"Other","percent":0}]}},"behaviors":null}}}';

export const codexUsageAnswer = {
  account_id: 'acct_1',
  user_id: 'user-1',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 1790686800 },
    secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 500000, reset_at: 1791163200 },
  },
  credits: { has_credits: true, unlimited: false, balance: '120', approx_local_messages: null, approx_cloud_messages: null },
  spend_control: null,
  additional_rate_limits: [
    {
      limit_name: 'codex_other',
      metered_feature: 'codex_other',
      rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 88, limit_window_seconds: 1800, reset_after_seconds: 600, reset_at: 1790683800 } },
    },
  ],
  rate_limit_reached_type: null,
  rate_limit_reset_credits: { available_count: 0 },
};
