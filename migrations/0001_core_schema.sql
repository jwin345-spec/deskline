-- deskline core schema.
--
-- Tenancy model: every tenant-owned row carries workspace_id. Requests run
-- inside a transaction that switches to the unprivileged role deskline_app and
-- sets app.workspace_id; the row-level security policies below then make rows
-- from other workspaces invisible and unwritable, independently of the
-- WHERE clauses the application also adds. System work (sessions, the SLA
-- worker, webhook routing) runs as the owning role, which RLS does not apply to.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'deskline_app') then
    create role deskline_app nologin;
  end if;
exception when duplicate_object or unique_violation then
  -- Roles are cluster-wide; a concurrent migration (e.g. parallel test schemas) created it.
  null;
end
$$;

-- The connecting role must be allowed to SET ROLE deskline_app. Superusers
-- (PGlite, the docker-compose user) already can; this covers least-privilege
-- owners. It is a no-op error when the grant already exists or is not needed.
do $$
begin
  execute format('grant deskline_app to %I', current_user);
exception when others then
  null;
end
$$;

do $$
begin
  execute format('grant usage on schema %I to deskline_app', current_schema());
end
$$;

-- The workspace of the current tenant transaction, or NULL outside one.
create function app_workspace_id() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null check (length(name) between 1 and 120),
  inbound_address text not null unique,
  webhook_secret text not null,
  ticket_seq integer not null default 0,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text not null check (length(name) between 1 and 120),
  password_hash text not null,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table memberships (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

-- Session ids are the SHA-256 of the cookie token, so a leaked table dump
-- cannot be replayed as cookies.
create table sessions (
  id text primary key,
  user_id uuid not null references users (id) on delete cascade,
  workspace_id uuid not null references workspaces (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions (user_id);

create table customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  email text not null,
  name text,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create unique index customers_workspace_email_key on customers (workspace_id, lower(email));

create table sla_policies (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  first_response_minutes integer not null check (first_response_minutes > 0),
  resolution_minutes integer not null check (resolution_minutes > 0),
  primary key (workspace_id, priority)
);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  number integer not null,
  subject text not null check (length(subject) between 1 and 300),
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  customer_id uuid not null,
  assignee_id uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  first_response_at timestamptz,
  resolved_at timestamptz,
  first_response_due_at timestamptz,
  resolution_due_at timestamptz,
  search_vector tsvector not null default ''::tsvector,
  unique (workspace_id, number),
  -- Lets child tables reference (workspace_id, id) so a message or audit row
  -- can never point at a ticket in another workspace.
  unique (workspace_id, id),
  foreign key (workspace_id, customer_id) references customers (workspace_id, id)
);
-- Inbox order and keyset pagination: newest activity first, id as tiebreaker.
create index tickets_inbox_idx on tickets (workspace_id, last_activity_at desc, id desc);
create index tickets_status_idx on tickets (workspace_id, status, last_activity_at desc);
create index tickets_assignee_idx on tickets (workspace_id, assignee_id, last_activity_at desc);
create index tickets_search_idx on tickets using gin (search_vector);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ticket_id uuid not null,
  author_type text not null check (author_type in ('customer', 'agent', 'system')),
  author_user_id uuid references users (id) on delete set null,
  customer_id uuid,
  body text not null check (length(body) between 1 and 50000),
  internal boolean not null default false,
  -- RFC 5322 Message-ID: inbound ids from the email provider, outbound ids we
  -- mint for agent replies. Used to thread replies via In-Reply-To/References.
  email_message_id text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, ticket_id) references tickets (workspace_id, id) on delete cascade,
  foreign key (workspace_id, customer_id) references customers (workspace_id, id),
  check (not (internal and author_type = 'customer'))
);
create index messages_ticket_idx on messages (ticket_id, created_at);
create unique index messages_email_id_key on messages (workspace_id, email_message_id)
  where email_message_id is not null;

-- Idempotency ledger for the inbound-email webhook: one row per provider
-- message id, written in the same transaction as the ticket/message it produced.
create table inbound_emails (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  message_id text not null,
  ticket_id uuid not null,
  outcome text not null check (outcome in ('created', 'threaded')),
  received_at timestamptz not null default now(),
  primary key (workspace_id, message_id),
  foreign key (workspace_id, ticket_id) references tickets (workspace_id, id) on delete cascade
);

-- Append-only audit trail. The app role can insert and read, never update or delete.
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  ticket_id uuid,
  actor_type text not null check (actor_type in ('user', 'customer', 'system')),
  actor_user_id uuid references users (id) on delete set null,
  action text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, ticket_id) references tickets (workspace_id, id) on delete cascade
);
create index audit_events_ticket_idx on audit_events (ticket_id, created_at);
create index audit_events_workspace_idx on audit_events (workspace_id, created_at desc);

create table sla_breaches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  ticket_id uuid not null,
  kind text not null check (kind in ('first_response', 'resolution')),
  due_at timestamptz not null,
  breached_at timestamptz not null default now(),
  unique (ticket_id, kind),
  foreign key (workspace_id, ticket_id) references tickets (workspace_id, id) on delete cascade
);
create index sla_breaches_workspace_idx on sla_breaches (workspace_id, breached_at desc);

-- Durable background jobs, claimed with FOR UPDATE SKIP LOCKED.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_due_idx on jobs (run_at) where status = 'queued';
create index jobs_lease_idx on jobs (locked_until) where status = 'running';

-- Full-text search document: subject (weight A) plus every public message
-- body (weight B). Maintained by triggers so no code path can forget it.
-- Internal notes are deliberately not indexed.
create function tickets_refresh_search(target uuid) returns void
  language sql
  as $$
    update tickets t
       set search_vector =
             setweight(to_tsvector('english', t.subject), 'A') ||
             setweight(to_tsvector('english', coalesce((
               select string_agg(m.body, ' ' order by m.created_at)
                 from messages m
                where m.ticket_id = t.id and not m.internal
             ), '')), 'B')
     where t.id = target
  $$;

create function messages_search_trigger() returns trigger
  language plpgsql
  as $$
  begin
    if not new.internal then
      perform tickets_refresh_search(new.ticket_id);
    end if;
    return null;
  end
  $$;

create trigger messages_search_after_insert
  after insert on messages
  for each row execute function messages_search_trigger();

create function tickets_subject_search_trigger() returns trigger
  language plpgsql
  as $$
  begin
    perform tickets_refresh_search(new.id);
    return null;
  end
  $$;

create trigger tickets_search_after_subject
  after insert or update of subject on tickets
  for each row execute function tickets_subject_search_trigger();

-- Row-level security ---------------------------------------------------------

alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table users enable row level security;
alter table customers enable row level security;
alter table sla_policies enable row level security;
alter table tickets enable row level security;
alter table messages enable row level security;
alter table inbound_emails enable row level security;
alter table audit_events enable row level security;
alter table sla_breaches enable row level security;
alter table jobs enable row level security;

create policy tenant_isolation on workspaces
  using (id = app_workspace_id()) with check (id = app_workspace_id());

create policy tenant_isolation on memberships
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());

-- Users are global (one login, many workspaces); a tenant sees only its members.
create policy tenant_members on users
  using (exists (
    select 1 from memberships m
     where m.user_id = users.id and m.workspace_id = app_workspace_id()
  ));

create policy tenant_isolation on customers
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on sla_policies
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on tickets
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on messages
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on inbound_emails
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on audit_events
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on sla_breaches
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());
create policy tenant_isolation on jobs
  using (workspace_id = app_workspace_id()) with check (workspace_id = app_workspace_id());

-- Grants for the tenant role: least privilege, column-level where it matters.
grant select, update (ticket_seq) on workspaces to deskline_app;
grant select, update (role) on memberships to deskline_app;
-- password_hash is deliberately not readable by tenant code.
grant select (id, email, name, created_at) on users to deskline_app;
grant select, insert, update (name) on customers to deskline_app;
grant select on sla_policies to deskline_app;
grant select, update (
  subject, status, priority, assignee_id, updated_at, last_activity_at, first_response_at,
  resolved_at, first_response_due_at, resolution_due_at, search_vector
), insert on tickets to deskline_app;
grant select, insert on messages to deskline_app;
grant select, insert on inbound_emails to deskline_app;
grant select, insert on audit_events to deskline_app;
grant select on sla_breaches to deskline_app;
grant insert on jobs to deskline_app;
