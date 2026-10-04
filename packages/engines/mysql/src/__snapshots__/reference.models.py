# Django models for the design, written by SchemaLoom in the style of `manage.py inspectdb`.
# Every model is `managed = False`, so Django never creates, alters or drops these tables.
# Remove those lines if Django should manage them.
from django.db import models


class CustomersStatus(models.TextChoices):
    ACTIVE = 'active'
    CLOSED = 'closed'


class Customers(models.Model):
    id = models.BigAutoField(primary_key=True)
    email = models.CharField(max_length=255, unique=True)
    status = models.CharField(max_length=6, choices=CustomersStatus.choices)
    bio = models.TextField(blank=True, null=True)
    updated_at = models.DateTimeField()

    class Meta:
        managed = False
        db_table = 'customers'
        indexes = [
            models.Index(fields=['email'], name='idx_email_prefix'),
        ]
        # Index 'ft_bio' is not listed: it is a fulltext index.
        # Index 'idx_status_lower' is not listed: it indexes an expression.


class Orders(models.Model):
    """Every customer's orders, one row per order"""

    id = models.BigAutoField(primary_key=True)
    customer = models.ForeignKey('Customers', models.RESTRICT, db_comment='Who placed the order')
    total = models.DecimalField(max_digits=12, decimal_places=2)
    net_total = models.DecimalField(max_digits=12, decimal_places=2, blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'orders'
        indexes = [
            models.Index(fields=['customer', '-total'], name='idx_customer_id'),
        ]
        # CHECK 'orders_total_positive': `total` > 0


class OrderSummary(models.Model):
    """A view."""

    id = models.TextField(primary_key=True)

    class Meta:
        managed = False
        db_table = 'order_summary'

