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
  Code2,
  Columns3,
  ChevronDown,
  ChevronRight,
  Database,
  FilePlus2,
  FileText,
  LayoutGrid,
  Link2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Sun,
  Table2,
  Upload,
  Users,
  X,
} from 'lucide-react';
export type { LucideIcon } from 'lucide-react';
