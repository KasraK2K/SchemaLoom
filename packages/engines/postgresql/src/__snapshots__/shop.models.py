# Django models for the design, written by SchemaLoom in the style of `manage.py inspectdb`.
# Every model is `managed = False`, so Django never creates, alters or drops these tables.
# Remove those lines if Django should manage them.
from django.contrib.postgres.fields import ArrayField
from django.db import models


class UserRole(models.TextChoices):
    MEMBER = 'member'
    ADMIN = 'admin'
    SUPER_ADMIN = 'super-admin'


class AuditLog(models.Model):
    # The table has no primary key; Django adds an `id` it does not have.
    at = models.DateTimeField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'audit_log'


class Users(models.Model):
    """People who sign in"""

    id = models.UUIDField(primary_key=True)
    email = models.CharField(max_length=320, unique=True)
    name = models.TextField(blank=True, null=True, db_comment='Shown "as is"')
    tags = ArrayField(models.TextField(), blank=True, null=True)
    role = models.CharField(max_length=11, choices=UserRole.choices)
    balance = models.DecimalField(max_digits=12, decimal_places=2)
    created_at = models.DateTimeField()
    display_name = models.CharField(max_length=80, db_column='Display Name', blank=True, null=True)
    manager = models.ForeignKey('self', models.DO_NOTHING, related_name='users_manager_set', blank=True, null=True)
    active = models.TextField(blank=True, null=True)  # This field type is a guess.

    class Meta:
        managed = False
        db_table = 'users'
        # Index 'users_lower_email' is not listed: it indexes an expression.
        # CHECK 'users_balance_check': balance >= 0


class Posts(models.Model):
    id = models.BigAutoField(primary_key=True)
    author = models.ForeignKey('Users', models.CASCADE, related_name='posts_author_set')
    editor = models.ForeignKey('Users', models.SET_NULL, related_name='posts_editor_set', blank=True, null=True)
    body = models.JSONField(blank=True, null=True)
    status = models.SmallIntegerField()
    title = models.TextField()

    class Meta:
        managed = False
        db_table = 'posts'
        constraints = [
            models.UniqueConstraint(fields=['title', 'status'], name='posts_title_status_key'),
        ]
        indexes = [
            models.Index(fields=['author'], name='posts_author_id_idx'),
            models.Index(fields=['-status', 'title'], name='posts_status_title_idx'),
        ]
        # Index 'posts_body_gin' is not listed: it is a gin index.


class Profiles(models.Model):
    user = models.OneToOneField('Users', models.DO_NOTHING, primary_key=True)
    bio = models.TextField(blank=True, null=True)

    class Meta:
        managed = False
        db_table = 'profiles'


class Invoices(models.Model):
    id = models.AutoField(primary_key=True)

    class Meta:
        managed = False
        db_table = '"sales"."invoices"'


class RecentPosts(models.Model):
    """A view."""

    class Meta:
        managed = False
        db_table = 'recent_posts'

