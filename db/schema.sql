-- FieldsOps — skema database MySQL 8+
-- Marketplace jasa perbaikan & pemeliharaan.
-- Sesuai SRS 1.1: customer, technician, admin; booking → service order →
-- assignment → work order → transaksi/komisi → ulasan.

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(160) NOT NULL,
  phone         VARCHAR(24) NULL,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('customer','technician','admin') NOT NULL DEFAULT 'customer',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id     INT UNSIGNED NOT NULL,
  address     VARCHAR(300) NULL,
  city        VARCHAR(80) NULL,
  postal_code VARCHAR(10) NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_customer_profile_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS technician_profiles (
  user_id         INT UNSIGNED NOT NULL,
  status          ENUM('pending','under_review','revision_required','approved','rejected','suspended') NOT NULL DEFAULT 'pending',
  bio             VARCHAR(400) NULL,
  experience_years TINYINT UNSIGNED NOT NULL DEFAULT 0,
  service_area    VARCHAR(160) NULL,
  ktp_number      VARCHAR(32) NULL,
  document_url    VARCHAR(255) NULL,
  review_note     VARCHAR(400) NULL,
  is_available    TINYINT(1) NOT NULL DEFAULT 1,
  submitted_at    TIMESTAMP NULL DEFAULT NULL,
  reviewed_at     TIMESTAMP NULL DEFAULT NULL,
  reviewed_by     INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_tech_status (status),
  CONSTRAINT fk_tech_profile_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_tech_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categories (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80) NOT NULL,
  slug        VARCHAR(90) NOT NULL,
  description VARCHAR(240) NULL,
  icon        VARCHAR(20) NOT NULL DEFAULT 'wrench',
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS technician_competencies (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  technician_id INT UNSIGNED NOT NULL,
  category_id   INT UNSIGNED NOT NULL,
  status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  note          VARCHAR(240) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_competency (technician_id, category_id),
  CONSTRAINT fk_competency_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_competency_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS availability (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  technician_id INT UNSIGNED NOT NULL,
  day_of_week   TINYINT UNSIGNED NOT NULL COMMENT '0=Minggu .. 6=Sabtu',
  start_time    TIME NOT NULL DEFAULT '08:00:00',
  end_time      TIME NOT NULL DEFAULT '17:00:00',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_availability (technician_id, day_of_week),
  CONSTRAINT fk_availability_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id      INT UNSIGNED NOT NULL,
  name             VARCHAR(140) NOT NULL,
  slug             VARCHAR(160) NOT NULL,
  description      VARCHAR(600) NULL,
  scope            VARCHAR(600) NULL,
  requirements     VARCHAR(600) NULL,
  price_type       ENUM('fixed','estimate') NOT NULL DEFAULT 'fixed',
  price            DECIMAL(12,2) NOT NULL DEFAULT 0,
  duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  service_area     VARCHAR(160) NULL,
  image_url        VARCHAR(255) NOT NULL DEFAULT '/img/placeholder.svg',
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  is_featured      TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_services_slug (slug),
  KEY idx_services_category (category_id, is_active),
  CONSTRAINT fk_services_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(24) NOT NULL,
  customer_id     INT UNSIGNED NOT NULL,
  address         VARCHAR(300) NOT NULL,
  city            VARCHAR(80) NOT NULL,
  postal_code     VARCHAR(10) NULL,
  scheduled_date  DATE NOT NULL,
  scheduled_time  TIME NOT NULL,
  notes           VARCHAR(500) NULL,
  photo_url       VARCHAR(255) NULL,
  subtotal        DECIMAL(12,2) NOT NULL DEFAULT 0,
  total           DECIMAL(12,2) NOT NULL DEFAULT 0,
  status          ENUM('submitted','processing','in_progress','completed','cancelled') NOT NULL DEFAULT 'submitted',
  payment_method  ENUM('full','cod') NOT NULL DEFAULT 'full',
  payment_channel ENUM('transfer','qris') NULL,
  payment_status  ENUM('unpaid','pending_verification','paid','refunded') NOT NULL DEFAULT 'unpaid',
  cancel_reason   VARCHAR(300) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bookings_code (code),
  KEY idx_bookings_customer (customer_id, status),
  KEY idx_bookings_schedule (scheduled_date, scheduled_time),
  CONSTRAINT fk_bookings_customer FOREIGN KEY (customer_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_orders (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  booking_id     INT UNSIGNED NOT NULL,
  service_id     INT UNSIGNED NULL,
  service_name   VARCHAR(140) NOT NULL,
  category_name  VARCHAR(80) NOT NULL,
  price_type     ENUM('fixed','estimate') NOT NULL DEFAULT 'fixed',
  price          DECIMAL(12,2) NOT NULL DEFAULT 0,
  qty            SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status         ENUM('submitted','awaiting_assignment','assigned','in_progress','completed','cancelled','needs_reschedule') NOT NULL DEFAULT 'submitted',
  technician_id  INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_so_booking (booking_id),
  KEY idx_so_technician (technician_id, status),
  KEY idx_so_status (status),
  CONSTRAINT fk_so_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_so_service FOREIGN KEY (service_id) REFERENCES services (id) ON DELETE SET NULL,
  CONSTRAINT fk_so_technician FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignments (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_order_id INT UNSIGNED NOT NULL,
  technician_id    INT UNSIGNED NOT NULL,
  status           ENUM('offered','accepted','rejected','reassigned','cancelled') NOT NULL DEFAULT 'offered',
  reason           VARCHAR(300) NULL,
  assigned_by      INT UNSIGNED NULL,
  responded_at     TIMESTAMP NULL DEFAULT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_assignment_tech (technician_id, status),
  KEY idx_assignment_so (service_order_id),
  CONSTRAINT fk_assignment_so FOREIGN KEY (service_order_id) REFERENCES service_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_admin FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS work_orders (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_order_id INT UNSIGNED NOT NULL,
  technician_id    INT UNSIGNED NOT NULL,
  instructions     VARCHAR(600) NULL,
  findings         VARCHAR(600) NULL,
  actions_taken    VARCHAR(600) NULL,
  evidence_url     VARCHAR(255) NULL,
  status           ENUM('assigned','accepted','in_progress','blocked','submitted_for_review','completed') NOT NULL DEFAULT 'assigned',
  started_at       TIMESTAMP NULL DEFAULT NULL,
  completed_at     TIMESTAMP NULL DEFAULT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_work_order_so (service_order_id),
  KEY idx_work_order_tech (technician_id, status),
  CONSTRAINT fk_wo_so FOREIGN KEY (service_order_id) REFERENCES service_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_wo_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transactions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  reference   VARCHAR(32) NOT NULL,
  booking_id  INT UNSIGNED NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  method      ENUM('full','cod') NOT NULL,
  channel     ENUM('transfer','qris') NULL,
  status      ENUM('unpaid','pending_verification','paid','failed','expired','refunded') NOT NULL DEFAULT 'unpaid',
  proof_url   VARCHAR(255) NULL,
  verified_by INT UNSIGNED NULL,
  verified_at TIMESTAMP NULL DEFAULT NULL,
  refund_reason VARCHAR(300) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transactions_reference (reference),
  KEY idx_transactions_booking (booking_id),
  KEY idx_transactions_status (status),
  CONSTRAINT fk_transactions_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_transactions_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS commission_rules (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  percent        DECIMAL(5,2) NOT NULL,
  effective_from DATE NOT NULL,
  created_by     INT UNSIGNED NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_commission_rule_admin FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS commissions (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_order_id INT UNSIGNED NOT NULL,
  booking_id       INT UNSIGNED NOT NULL,
  technician_id    INT UNSIGNED NOT NULL,
  gross_amount     DECIMAL(12,2) NOT NULL,
  percent          DECIMAL(5,2) NOT NULL,
  platform_fee     DECIMAL(12,2) NOT NULL,
  technician_earning DECIMAL(12,2) NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_commission_so (service_order_id),
  KEY idx_commission_tech (technician_id),
  CONSTRAINT fk_commission_so FOREIGN KEY (service_order_id) REFERENCES service_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_commission_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_commission_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_order_id INT UNSIGNED NOT NULL,
  booking_id       INT UNSIGNED NOT NULL,
  customer_id      INT UNSIGNED NOT NULL,
  technician_id    INT UNSIGNED NOT NULL,
  rating           TINYINT UNSIGNED NOT NULL,
  comment          VARCHAR(600) NULL,
  is_hidden        TINYINT(1) NOT NULL DEFAULT 0,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_review_so (service_order_id),
  KEY idx_reviews_tech (technician_id),
  CONSTRAINT fk_review_so FOREIGN KEY (service_order_id) REFERENCES service_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_customer FOREIGN KEY (customer_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_tech FOREIGN KEY (technician_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS complaints (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(24) NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  booking_id  INT UNSIGNED NULL,
  subject     VARCHAR(160) NOT NULL,
  message     VARCHAR(800) NOT NULL,
  attachment_url VARCHAR(255) NULL,
  status      ENUM('open','in_review','resolved','rejected') NOT NULL DEFAULT 'open',
  response    VARCHAR(600) NULL,
  handled_by  INT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_complaints_code (code),
  KEY idx_complaints_user (user_id),
  KEY idx_complaints_status (status),
  CONSTRAINT fk_complaint_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_complaint_booking FOREIGN KEY (booking_id) REFERENCES bookings (id) ON DELETE SET NULL,
  CONSTRAINT fk_complaint_handler FOREIGN KEY (handled_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  title      VARCHAR(160) NOT NULL,
  body       VARCHAR(400) NULL,
  link       VARCHAR(200) NULL,
  is_read    TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id, is_read, created_at),
  CONSTRAINT fk_notification_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    INT UNSIGNED NULL,
  actor_role  VARCHAR(20) NULL,
  action      VARCHAR(60) NOT NULL,
  entity      VARCHAR(40) NOT NULL,
  entity_id   INT UNSIGNED NULL,
  description VARCHAR(400) NOT NULL,
  meta_json   TEXT NULL,
  ip          VARCHAR(64) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS status_history (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity_type ENUM('booking','service_order','work_order','technician') NOT NULL,
  entity_id   INT UNSIGNED NOT NULL,
  from_status VARCHAR(40) NULL,
  to_status   VARCHAR(40) NOT NULL,
  actor_id    INT UNSIGNED NULL,
  note        VARCHAR(300) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_history_entity (entity_type, entity_id),
  CONSTRAINT fk_history_actor FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(60) NOT NULL,
  setting_value VARCHAR(400) NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  token_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_reset_token (token_hash),
  CONSTRAINT fk_reset_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
