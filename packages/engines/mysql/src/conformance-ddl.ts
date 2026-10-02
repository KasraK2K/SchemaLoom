/**
 * Import fixtures, test-only. `ECOMMERCE_DDL` is what `mysqldump --no-data` writes for MySQL
 * 8.4 (version comments, DROP/SET framing, a placeholder view replaced by the real one), so
 * every statement must apply or be framing. `MIXED_DDL` exercises every report status.
 */

export const ECOMMERCE_DDL = `-- MySQL dump 10.13  Distrib 8.4.0, for Linux (x86_64)
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

DROP TABLE IF EXISTS \`customers\`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE \`customers\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Login address',
  \`full_name\` varchar(200) DEFAULT NULL,
  \`status\` enum('active','suspended','closed') NOT NULL DEFAULT 'active',
  \`balance\` decimal(12,2) NOT NULL DEFAULT '0.00',
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`email_lower\` varchar(255) GENERATED ALWAYS AS (lower(\`email\`)) VIRTUAL,
  \`is_vip\` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`customers_email_uq\` (\`email\`),
  KEY \`idx_name_prefix\` (\`full_name\`(20)),
  KEY \`idx_lower_email\` ((lower(\`email\`))),
  FULLTEXT KEY \`ft_name\` (\`full_name\`),
  CONSTRAINT \`balance_nonneg\` CHECK ((\`balance\` >= 0))
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='People with an account';
/*!40101 SET character_set_client = @saved_cs_client */;

DROP TABLE IF EXISTS \`orders\`;
CREATE TABLE \`orders\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`customer_id\` bigint unsigned NOT NULL,
  \`total\` decimal(12,2) NOT NULL,
  \`placed_at\` datetime(3) NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_customer_id\` (\`customer_id\`,\`placed_at\` DESC),
  CONSTRAINT \`fk_orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP TABLE IF EXISTS \`big_orders\`;
/*!50001 DROP VIEW IF EXISTS \`big_orders\`*/;
/*!50001 CREATE VIEW \`big_orders\` AS SELECT
 1 AS \`id\`,
 1 AS \`total\` */;

/*!50001 DROP VIEW IF EXISTS \`big_orders\`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=\`root\`@\`%\` SQL SECURITY DEFINER */
/*!50001 VIEW \`big_orders\` AS select \`orders\`.\`id\` AS \`id\`,\`orders\`.\`total\` AS \`total\` from \`orders\` where (\`orders\`.\`total\` > 100) */;

/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
`;

export const MIXED_DDL = `
SET NAMES utf8mb4;

CREATE TABLE invoices (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  amount DECIMAL(12,2) NOT NULL
);

CREATE INDEX idx_amount ON invoices (amount);

DELIMITER ;;
CREATE TRIGGER invoices_bi BEFORE INSERT ON invoices FOR EACH ROW BEGIN
  SET NEW.amount = ROUND(NEW.amount, 2);
END ;;
DELIMITER ;

CREATE TABLE events (id INT NOT NULL, at DATE NOT NULL, PRIMARY KEY (id, at))
PARTITION BY RANGE (YEAR(at)) (PARTITION p2025 VALUES LESS THAN (2026), PARTITION pmax VALUES LESS THAN MAXVALUE);

INSERT INTO invoices (amount) VALUES (10.00);

CREATE TABL typo (id INT);
`;
