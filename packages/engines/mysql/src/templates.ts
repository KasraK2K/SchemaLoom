import type { ProjectTemplate } from '@schemaloom/engine-sdk';

/**
 * Phase 12's starting schemas, in MySQL. The same three as the PostgreSQL engine's, written
 * the MySQL way: `ENUM` columns inline, unsigned `AUTO_INCREMENT` keys, `ENGINE=InnoDB`, and
 * docs as inline `COMMENT '…'`, which the importer turns into docs. `templates/import-cleanly`
 * fails if any statement stops applying.
 */

const ECOMMERCE = `CREATE TABLE customers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL COMMENT 'Login and contact address. Unique across all customers.',
  full_name VARCHAR(200) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY customers_email_uq (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='People who have an account with the shop. One row per account.';

CREATE TABLE addresses (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  line1 VARCHAR(200) NOT NULL,
  line2 VARCHAR(200) NULL,
  city VARCHAR(100) NOT NULL,
  postal_code VARCHAR(16) NOT NULL,
  country CHAR(2) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_customer_id (customer_id),
  CONSTRAINT fk_addresses_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Shipping addresses a customer has saved. Deleted with the customer.';

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  list_price DECIMAL(10,2) NOT NULL COMMENT 'Current price. Orders keep the price they were placed at.',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (id),
  UNIQUE KEY products_sku_uq (sku),
  CONSTRAINT products_price_nonneg CHECK (list_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='The catalogue. Inactive products stay for old orders but are not for sale.';

CREATE TABLE orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  shipping_address_id BIGINT UNSIGNED NULL,
  status ENUM('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending' COMMENT 'pending until paid, then shipped; cancelled can happen at any point before shipping.',
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_customer_id (customer_id),
  KEY idx_status_placed (status, placed_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT fk_orders_address FOREIGN KEY (shipping_address_id) REFERENCES addresses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='One row per checkout. The total is the sum of its order items.';

CREATE TABLE order_items (
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL COMMENT 'The product price when the order was placed.',
  PRIMARY KEY (order_id, product_id),
  KEY idx_product_id (product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT items_quantity_positive CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='The products in an order, one row per product.';

CREATE TABLE payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_order_id (order_id),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Money received for an order. An order can have several payments.';
`;

const SAAS = `CREATE TABLE organizations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  slug VARCHAR(64) NOT NULL COMMENT 'URL-safe name, unique across all organizations.',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY organizations_slug_uq (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='A tenant: the company or team that pays. Every other row belongs to one.';

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  display_name VARCHAR(200) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_uq (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='A person who can sign in. A user can belong to several organizations.';

CREATE TABLE memberships (
  organization_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id),
  KEY idx_user_id (user_id),
  CONSTRAINT fk_memberships_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT fk_memberships_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Which users belong to which organization, and with what role.';

CREATE TABLE plans (
  id VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  monthly_price DECIMAL(10,2) NOT NULL,
  seat_limit INT UNSIGNED NULL COMMENT 'Maximum members on this plan. Empty means unlimited.',
  PRIMARY KEY (id),
  CONSTRAINT plans_price_nonneg CHECK (monthly_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='What can be bought. The id is a readable key such as starter or pro.';

CREATE TABLE subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  plan_id VARCHAR(32) NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME NULL COMMENT 'Set when the subscription ends. Empty while it is active.',
  PRIMARY KEY (id),
  KEY idx_organization_id (organization_id),
  KEY idx_plan_id (plan_id),
  CONSTRAINT fk_subscriptions_org FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='An organization on a plan. One active subscription per organization.';

CREATE TABLE invoices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_id BIGINT UNSIGNED NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL COMMENT 'Empty while the invoice is unpaid.',
  PRIMARY KEY (id),
  KEY idx_subscription_id (subscription_id),
  KEY idx_unpaid (paid_at, issued_at),
  CONSTRAINT fk_invoices_subscription FOREIGN KEY (subscription_id) REFERENCES subscriptions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='One row per billing period of a subscription.';
`;

const BLOG = `CREATE TABLE authors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(200) NOT NULL,
  bio TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY authors_email_uq (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='People who write posts.';

CREATE TABLE posts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  author_id BIGINT UNSIGNED NOT NULL,
  slug VARCHAR(200) NOT NULL COMMENT 'The post URL path. Unique across all posts.',
  title VARCHAR(300) NOT NULL,
  body MEDIUMTEXT NOT NULL,
  status ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at DATETIME NULL COMMENT 'Set when the post is published; required for a published post.',
  PRIMARY KEY (id),
  UNIQUE KEY posts_slug_uq (slug),
  KEY idx_author_id (author_id),
  KEY idx_status_published (status, published_at),
  FULLTEXT KEY ft_title_body (title, body),
  CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES authors (id),
  CONSTRAINT posts_published_has_date CHECK (status <> 'published' OR published_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Articles. Only published posts are shown to readers.';

CREATE TABLE tags (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY tags_name_uq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Topics a post can be filed under.';

CREATE TABLE post_tags (
  post_id BIGINT UNSIGNED NOT NULL,
  tag_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_tag_id (tag_id),
  CONSTRAINT fk_post_tags_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_post_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Which tags each post has.';

CREATE TABLE comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id BIGINT UNSIGNED NOT NULL,
  author_name VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_post_id (post_id),
  CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Reader comments on a post. Deleted with the post.';
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
