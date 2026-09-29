export const recordedClaudeModels = {
  data: [
    { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-28T00:00:00Z' },
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T16:24:00Z' },
    { type: 'model', id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-08-28T00:00:00Z' },
    { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-07-24T00:00:00Z' },
    { type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z' },
    { type: 'model', id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2026-06-07T00:00:00Z' },
    { type: 'model', id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-28T00:00:00Z' },
    { type: 'model', id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-14T00:00:00Z' },
    { type: 'model', id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-02-17T00:00:00Z' },
    { type: 'model', id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-02-04T00:00:00Z' },
    { type: 'model', id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-24T00:00:00Z' },
    { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z' },
    { type: 'model', id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2025-09-29T00:00:00Z' },
  ],
  has_more: false,
  first_id: 'claude-sonnet-5-5',
  last_id: 'claude-sonnet-4-5-20250929',
};

export const THINKING_OFF_REFUSAL =
  '{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.disabled\\" is not supported for this model. Use \\"thinking.type.between_tools\\" for the lowest thinking setting, or \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}';
