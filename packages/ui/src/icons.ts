/**
 * The icon set, re-exported by name.
 *
 * `lucide-react` is a dependency of this package, not of apps/web, and pnpm's strict
 * node_modules means the app cannot reach it directly. Re-exporting by name (rather
 * than `export *`) keeps the app on one icon vocabulary and keeps tree-shaking working
 * — `import * as Icons` would pull the whole set into the bundle.
 *
 * Add an icon here when a consumer needs one. Do not add "just in case".
 */
export {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns3,
  Database,
  FilePlus2,
  FileText,
  GitPullRequestArrow,
  Group,
  Inbox,
  LayoutGrid,
  Link2,
  Maximize,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Table2,
  TriangleAlert,
  Upload,
  Users,
  X,
} from 'lucide-react';
export type { LucideIcon } from 'lucide-react';
