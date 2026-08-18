-- Janus Assist: token observation logs + cross-session analytic memories.
-- Apply manually in Supabase. No conversations table (id is a client/session UUID only).

BEGIN;

CREATE TABLE IF NOT EXISTS public.assist_turn_token_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  turn_number integer NOT NULL,
  call_index integer NOT NULL,
  input_tokens integer NULL,
  output_tokens integer NULL,
  conversation_context_tokens_estimated integer NULL,
  conversation_input_tokens_total integer NULL,
  conversation_output_tokens_total integer NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assist_turn_token_logs_conversation
  ON public.assist_turn_token_logs (conversation_id, turn_number, call_index);

CREATE TABLE IF NOT EXISTS public.assist_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  conclusion text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assist_memories_conversation
  ON public.assist_memories (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.assist_memory_entities (
  memory_id uuid NOT NULL REFERENCES public.assist_memories (id) ON DELETE CASCADE,
  entity_name text NOT NULL,
  PRIMARY KEY (memory_id, entity_name)
);

CREATE INDEX IF NOT EXISTS idx_assist_memory_entities_name
  ON public.assist_memory_entities (entity_name);

COMMENT ON TABLE public.assist_memories IS
  'Analytic conclusions from Assist turns. Not a chat transcript.';

COMMENT ON COLUMN public.assist_memories.evidence IS
  'Frozen snapshots [{ tool_name, tool_args, tool_result_snapshot, checked_at }]. Never re-queried to reconstruct the past.';

COMMIT;
