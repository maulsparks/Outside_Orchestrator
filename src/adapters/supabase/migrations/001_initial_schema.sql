-- Tier 3 State and Memory Plane: Initial Schema & RLS Policies (ISSUE-01)
-- Project: sbauhlhgqxzwyxrqujsr

-- 1. Helper Functions
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS TEXT AS $$
  SELECT public.get_claim('tenant_id');
$$ LANGUAGE sql STABLE;

-- 2. factory_runs
CREATE TABLE IF NOT EXISTS public.factory_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    parent_git_sha TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'created',
    state_version INT NOT NULL DEFAULT 1,
    budget JSONB NOT NULL DEFAULT '{}'::jsonb,
    envelope JSONB NOT NULL DEFAULT '{}'::jsonb,
    acceptance_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
    context_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT factory_runs_tenant_idempotency_uniq UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT factory_runs_phase_check CHECK (
        phase IN (
            'created',
            'provisioning',
            'delegated',
            'in_progress',
            'evaluating',
            'terminal',
            'clean_terminated',
            'quarantined'
        )
    )
);

-- 3. leases
CREATE TABLE IF NOT EXISTS public.leases (
    run_id UUID PRIMARY KEY REFERENCES public.factory_runs(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    holder_id TEXT NOT NULL,
    fencing_token BIGINT NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT leases_fencing_token_positive CHECK (fencing_token > 0)
);

-- 4. phase_envelopes
CREATE TABLE IF NOT EXISTS public.phase_envelopes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.factory_runs(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    attempt INT NOT NULL DEFAULT 1,
    schema_version TEXT NOT NULL DEFAULT 'v1',
    inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs JSONB,
    envelope_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT phase_envelopes_run_phase_attempt_uniq UNIQUE (run_id, phase, attempt)
);

-- 5. memory_records
CREATE TABLE IF NOT EXISTS public.memory_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    context_type TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_records_tenant_hash 
ON public.memory_records (tenant_id, source_hash);

-- 6. events (Transactional Outbox)
CREATE TABLE IF NOT EXISTS public.events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.factory_runs(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT events_run_sequence_uniq UNIQUE (run_id, sequence)
);

-- 7. evidence_ledger
CREATE TABLE IF NOT EXISTS public.evidence_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.factory_runs(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    sandbox_id TEXT,
    sequence BIGINT NOT NULL,
    previous_event_hash TEXT NOT NULL,
    event_hash TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    key_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    payload JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT evidence_ledger_run_sequence_uniq UNIQUE (run_id, sequence),
    CONSTRAINT evidence_ledger_run_hash_uniq UNIQUE (run_id, event_hash)
);

-- 8. tournament_arms
CREATE TABLE IF NOT EXISTS public.tournament_arms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.factory_runs(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    arm_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    model_id TEXT,
    tree_sha TEXT,
    cost_cents INT NOT NULL DEFAULT 0,
    latency_ms INT NOT NULL DEFAULT 0,
    selection_status TEXT NOT NULL DEFAULT 'unselected',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tournament_arms_run_arm_uniq UNIQUE (run_id, arm_id)
);

-- 9. Row Level Security (RLS) Configuration
ALTER TABLE public.factory_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_arms ENABLE ROW LEVEL SECURITY;

-- Policies for factory_runs
DROP POLICY IF EXISTS "Runs isolated by tenant and run_id" ON public.factory_runs;
CREATE POLICY "Runs isolated by tenant and run_id"
ON public.factory_runs
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND id = public.current_run_id()
);

-- Policies for leases
DROP POLICY IF EXISTS "Leases isolated by tenant and run_id" ON public.leases;
CREATE POLICY "Leases isolated by tenant and run_id"
ON public.leases
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
);

-- Policies for phase_envelopes
DROP POLICY IF EXISTS "Phase envelopes isolated by tenant and run_id" ON public.phase_envelopes;
CREATE POLICY "Phase envelopes isolated by tenant and run_id"
ON public.phase_envelopes
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
);

-- Policies for memory_records
DROP POLICY IF EXISTS "Memory records isolated by tenant" ON public.memory_records;
CREATE POLICY "Memory records isolated by tenant"
ON public.memory_records
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
);

-- Policies for events
DROP POLICY IF EXISTS "Events isolated by tenant and run_id" ON public.events;
CREATE POLICY "Events isolated by tenant and run_id"
ON public.events
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
);

-- Policies for evidence_ledger
DROP POLICY IF EXISTS "Evidence ledger isolated by tenant and run_id" ON public.evidence_ledger;
CREATE POLICY "Evidence ledger isolated by tenant and run_id"
ON public.evidence_ledger
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
);

-- Policies for tournament_arms
DROP POLICY IF EXISTS "Tournament arms isolated by tenant and run_id" ON public.tournament_arms;
CREATE POLICY "Tournament arms isolated by tenant and run_id"
ON public.tournament_arms
FOR ALL
TO authenticated
USING (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
)
WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND run_id = public.current_run_id()
);
