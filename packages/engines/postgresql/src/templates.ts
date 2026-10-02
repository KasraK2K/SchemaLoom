import type { ProjectTemplate } from '@schemaloom/engine-sdk';

/**
 * Phase 12 — the schemas "Start from a template" offers. Plain DDL, imported by the ordinary
 * importer; `templates/import-cleanly` fails if any statement stops applying. That is why
 * there is no CREATE EXTENSION. The COMMENT ON statements become the project's first docs
 * (on tables and columns defined above them; anything else would be reported `ignored`).
 *
 * Each one shows a little of everything the canvas draws: FKs, a composite key, an enum, a
 * CHECK, a unique index and a partial index.
 */

const ECOMMERCE = `CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  postal_code varchar(16) NOT NULL,
  country char(2) NOT NULL
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku varchar(64) NOT NULL UNIQUE,
  name text NOT NULL,
  list_price numeric(10, 2) NOT NULL CHECK (list_price >= 0),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  shipping_address_id uuid REFERENCES addresses (id),
  status order_status NOT NULL DEFAULT 'pending',
  total numeric(12, 2) NOT NULL DEFAULT 0,
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  amount numeric(12, 2) NOT NULL,
  provider text NOT NULL,
  paid_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_open_idx ON orders (placed_at) WHERE status IN ('pending', 'paid');

COMMENT ON TABLE customers IS 'People who have an account with the shop. One row per account.';
COMMENT ON COLUMN customers.email IS 'Login and contact address. Unique across all customers.';
COMMENT ON TABLE addresses IS 'Shipping addresses a customer has saved. Deleted with the customer.';
COMMENT ON TABLE products IS 'The catalogue. Inactive products stay for old orders but are not for sale.';
COMMENT ON COLUMN products.list_price IS 'Current price. Orders keep the price they were placed at.';
COMMENT ON TABLE orders IS 'One row per checkout. The total is the sum of its order items.';
COMMENT ON COLUMN orders.status IS 'pending until paid, then shipped; cancelled can happen at any point before shipping.';
COMMENT ON TABLE order_items IS 'The products in an order, one row per product.';
COMMENT ON COLUMN order_items.unit_price IS 'The product price when the order was placed.';
COMMENT ON TABLE payments IS 'Money received for an order. An order can have several payments.';
`;

const SAAS = `CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug varchar(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE plans (
  id varchar(32) PRIMARY KEY,
  name text NOT NULL,
  monthly_price numeric(10, 2) NOT NULL CHECK (monthly_price >= 0),
  seat_limit integer
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  plan_id varchar(32) NOT NULL REFERENCES plans (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  amount numeric(12, 2) NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE UNIQUE INDEX subscriptions_one_active_idx ON subscriptions (organization_id) WHERE cancelled_at IS NULL;
CREATE INDEX invoices_unpaid_idx ON invoices (issued_at) WHERE paid_at IS NULL;

COMMENT ON TABLE organizations IS 'A tenant: the company or team that pays. Every other row belongs to one.';
COMMENT ON COLUMN organizations.slug IS 'URL-safe name, unique across all organizations.';
COMMENT ON TABLE users IS 'A person who can sign in. A user can belong to several organizations.';
COMMENT ON TABLE memberships IS 'Which users belong to which organization, and with what role.';
COMMENT ON TABLE plans IS 'What can be bought. The id is a readable key such as starter or pro.';
COMMENT ON COLUMN plans.seat_limit IS 'Maximum members on this plan. Empty means unlimited.';
COMMENT ON TABLE subscriptions IS 'An organization on a plan. At most one active subscription per organization.';
COMMENT ON COLUMN subscriptions.cancelled_at IS 'Set when the subscription ends. Empty while it is active.';
COMMENT ON TABLE invoices IS 'One row per billing period of a subscription.';
COMMENT ON COLUMN invoices.paid_at IS 'Empty while the invoice is unpaid.';
`;

const BLOG = `CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  bio text
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES authors (id),
  slug varchar(200) NOT NULL UNIQUE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status post_status NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE TABLE tags (
  id serial PRIMARY KEY,
  name varchar(64) NOT NULL UNIQUE
);

CREATE TABLE post_tags (
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id integer NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX posts_published_idx ON posts (published_at) WHERE status = 'published';
CREATE INDEX comments_post_id_idx ON comments (post_id);

COMMENT ON TABLE authors IS 'People who write posts.';
COMMENT ON TABLE posts IS 'Articles. Only published posts are shown to readers.';
COMMENT ON COLUMN posts.slug IS 'The post URL path. Unique across all posts.';
COMMENT ON COLUMN posts.published_at IS 'Set when the post is published; required for a published post.';
COMMENT ON TABLE tags IS 'Topics a post can be filed under.';
COMMENT ON TABLE post_tags IS 'Which tags each post has.';
COMMENT ON TABLE comments IS 'Reader comments on a post. Deleted with the post.';
`;

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'ecommerce',
    title: 'E-commerce',
    summary: 'Customers, products, orders and payments for an online shop.',
    tableCount: 6,
    importFormat: 'ddl',
    source: ECOMMERCE,
  },
  {
    id: 'saas',
    title: 'SaaS (multi-tenant)',
    summary: 'Organisations, users, memberships, plans, subscriptions and invoices.',
    tableCount: 6,
    importFormat: 'ddl',
    source: SAAS,
  },
  {
    id: 'blog',
    title: 'Blog',
    summary: 'Authors, posts, tags and comments.',
    tableCount: 5,
    importFormat: 'ddl',
    source: BLOG,
  },
];
