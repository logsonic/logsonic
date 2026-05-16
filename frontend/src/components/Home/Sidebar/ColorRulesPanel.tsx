import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ColorRule, useColorRuleStore } from "@/stores/useColorRuleStore";
import { useLogResultStore } from "@/stores/useLogResultStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchQueryParams";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

const FieldLabel = ({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) => (
  <label
    htmlFor={htmlFor}
    className="block text-[10.5px] font-medium leading-none"
    style={{ color: 'var(--ls-text-2)' }}
  >
    {children}
  </label>
);

const COMPACT_INPUT_CLS = "!h-7 !text-[11px] !px-2 !py-0 md:!text-[11px]";
const COMPACT_TRIGGER_CLS = "!h-7 !text-[11px] !px-2 !py-0";
const COMPACT_BUTTON_CLS = "!h-7 !text-[11px] !px-2.5";

// Palette for rule highlight colors. Each entry pairs the light Tailwind
// background used to highlight matching log rows with the darker text token
// used for the rule's title in the sidebar.
const HIGHLIGHT_COLORS = [
  { name: 'Red',     bg: 'bg-red-100',     text: 'text-red-700' },
  { name: 'Amber',   bg: 'bg-amber-100',   text: 'text-amber-700' },
  { name: 'Yellow',  bg: 'bg-yellow-100',  text: 'text-yellow-700' },
  { name: 'Green',   bg: 'bg-green-100',   text: 'text-green-700' },
  { name: 'Teal',    bg: 'bg-teal-100',    text: 'text-teal-700' },
  { name: 'Sky',     bg: 'bg-sky-100',     text: 'text-sky-700' },
  { name: 'Blue',    bg: 'bg-blue-100',    text: 'text-blue-700' },
  { name: 'Indigo',  bg: 'bg-indigo-100',  text: 'text-indigo-700' },
  { name: 'Violet',  bg: 'bg-violet-100',  text: 'text-violet-700' },
  { name: 'Purple',  bg: 'bg-purple-100',  text: 'text-purple-700' },
  { name: 'Pink',    bg: 'bg-pink-100',    text: 'text-pink-700' },
  { name: 'Rose',    bg: 'bg-rose-100',    text: 'text-rose-700' },
  { name: 'Slate',   bg: 'bg-slate-100',   text: 'text-slate-700' },
] as const;

const DEFAULT_COLOR = HIGHLIGHT_COLORS[0].bg;

const titleColorFromBg = (bg: string): string => {
  const entry = HIGHLIGHT_COLORS.find(c => c.bg === bg);
  return entry?.text ?? 'text-slate-700';
};

// Build a short title for the rule. Prefer the value (uppercased) since it's
// usually the most distinctive part ("ERROR", "WARN"); fall back to the field
// name for value-less operators like `exists`.
const ruleTitle = (rule: ColorRule): string => {
  if (rule.operator === 'exists' || !rule.value) return rule.field.toUpperCase();
  return rule.value.toUpperCase();
};

const ruleQuery = (rule: ColorRule): string => {
  switch (rule.operator) {
    case 'eq':       return `${rule.field}:${rule.value}`;
    case 'neq':      return `-${rule.field}:${rule.value}`;
    case 'contains': return `${rule.field}:*${rule.value}*`;
    case 'regex':    return `${rule.field}:/${rule.value}/`;
    case 'exists':   return `${rule.field}:*`;
    default:         return `${rule.field}:${rule.value}`;
  }
};

const triggerColorReapply = () => {
  // Re-set the same log data to nudge LogViewerTable into recomputing styles.
  setTimeout(() => {
    const logStore = useLogResultStore.getState();
    if (logStore.logData) logStore.setLogData({ ...logStore.logData });
  }, 0);
};

const ColorSwatchPicker = ({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (bg: string) => void;
}) => (
  <div className="grid grid-cols-7 gap-1.5">
    {HIGHLIGHT_COLORS.map((c) => (
      <Tooltip key={c.bg}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onSelect(c.bg)}
            className={cn(
              'h-6 w-6 rounded-md border transition-all flex items-center justify-center',
              c.bg,
              selected === c.bg
                ? 'ring-2 ring-offset-1 ring-[var(--ls-accent)] scale-105 border-transparent'
                : 'border-[var(--ls-border)] hover:scale-105'
            )}
            aria-label={c.name}
          >
            {selected === c.bg && <Check className={cn('h-3 w-3', c.text)} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="py-1 px-2 text-xs">
          {c.name}
        </TooltipContent>
      </Tooltip>
    ))}
  </div>
);

type DraftRule = Omit<ColorRule, 'id'>;

const blankDraft = (): DraftRule => ({
  field: '',
  operator: 'eq',
  value: '',
  color: DEFAULT_COLOR,
  enabled: true,
});

const RuleCard = ({
  rule,
  onToggle,
  onDelete,
  onEdit,
}: {
  rule: ColorRule;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
}) => {
  const titleColor = titleColorFromBg(rule.color);
  const disabled = !rule.enabled;

  return (
    <div
      className={cn(
        'group rounded-md border px-2.5 py-1.5 transition-all',
        // ls-rule-card hook lets dark mode dim the user-chosen pastel bg.
        !disabled && 'ls-rule-card',
        disabled ? 'bg-[var(--ls-bg-2)] border-[var(--ls-border)]' : cn(rule.color, 'border-transparent')
      )}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          className={cn(
            'flex-1 min-w-0 truncate text-left text-[12px] font-semibold tracking-tight leading-tight hover:underline',
            disabled ? 'text-[var(--ls-text-3)]' : titleColor
          )}
          title={`Edit rule: ${ruleTitle(rule)}`}
        >
          {ruleTitle(rule)}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="h-5 w-5 grid place-items-center rounded text-[var(--ls-text-3)] hover:text-[var(--ls-text)] hover:bg-[var(--ls-bg-2)] transition-colors opacity-0 group-hover:opacity-100"
          aria-label="Edit rule"
          title="Edit rule"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <Switch
          checked={rule.enabled}
          onCheckedChange={onToggle}
          className="h-3.5 w-7 data-[state=checked]:bg-[var(--ls-accent)] [&>span]:h-2.5 [&>span]:w-2.5 [&>span]:data-[state=checked]:translate-x-3.5"
        />
        <button
          type="button"
          onClick={onDelete}
          className="h-5 w-5 grid place-items-center rounded text-[var(--ls-text-3)] hover:text-[var(--ls-text)] hover:bg-[var(--ls-bg-2)] transition-colors"
          aria-label="Delete rule"
          title="Delete rule"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      <div
        className={cn(
          'mt-0.5 truncate text-[10.5px] leading-snug',
          disabled ? 'text-[var(--ls-text-3)]' : 'text-[var(--ls-text-2)]'
        )}
        style={{ fontFamily: 'var(--ls-font-mono)' }}
        title={ruleQuery(rule)}
      >
        {ruleQuery(rule)}
      </div>
    </div>
  );
};

const RuleForm = ({
  draft,
  setDraft,
  availableFields,
  onSave,
  onCancel,
  mode,
}: {
  draft: DraftRule;
  setDraft: (d: DraftRule) => void;
  availableFields: string[];
  onSave: () => void;
  onCancel: () => void;
  mode: 'add' | 'edit';
}) => {
  const saveDisabled = !draft.field || (draft.operator !== 'exists' && !draft.value);

  return (
    <div
      className={cn(
        'rounded-md border p-2 space-y-1.5',
        draft.color,
        'border-[var(--ls-border)]'
      )}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <div className="space-y-1">
          <FieldLabel htmlFor="rule-field">Field</FieldLabel>
          <Select
            value={draft.field}
            onValueChange={(value) => setDraft({ ...draft, field: value })}
          >
            <SelectTrigger
              id="rule-field"
              className={COMPACT_TRIGGER_CLS}
              disabled={!availableFields.length}
            >
              <SelectValue placeholder="Select field" />
            </SelectTrigger>
            <SelectContent>
              {availableFields.map((field) => (
                <SelectItem key={field} value={field} className="text-[11px]">
                  {field}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <FieldLabel htmlFor="rule-operator">Operator</FieldLabel>
          <Select
            value={draft.operator}
            onValueChange={(value) =>
              setDraft({ ...draft, operator: value as ColorRule['operator'] })
            }
          >
            <SelectTrigger id="rule-operator" className={COMPACT_TRIGGER_CLS}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="eq" className="text-[11px]">Equals (=)</SelectItem>
              <SelectItem value="neq" className="text-[11px]">Not equals (≠)</SelectItem>
              <SelectItem value="contains" className="text-[11px]">Contains</SelectItem>
              <SelectItem value="exists" className="text-[11px]">Exists</SelectItem>
              <SelectItem value="regex" className="text-[11px]">Regex</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <FieldLabel htmlFor="rule-value">
          {draft.operator === 'exists' ? 'Value (not needed)' : 'Value'}
        </FieldLabel>
        <Input
          id="rule-value"
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          className={COMPACT_INPUT_CLS}
          placeholder={
            draft.operator === 'exists'
              ? 'No value needed'
              : draft.operator === 'regex'
              ? 'error|warning'
              : 'Value to match'
          }
          disabled={draft.operator === 'exists'}
        />
      </div>

      <div className="space-y-1">
        <FieldLabel>Color</FieldLabel>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'h-7 w-full flex items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
                draft.color
              )}
              style={{ borderColor: 'var(--ls-border)' }}
              title="Choose highlight color"
            >
              <span className={cn('inline-block h-2.5 w-2.5 rounded-sm border', draft.color)} style={{ borderColor: 'var(--ls-border)' }} />
              <span className={titleColorFromBg(draft.color)}>
                {HIGHLIGHT_COLORS.find((c) => c.bg === draft.color)?.name ?? 'Color'}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[260px] p-2" side="right" align="start">
            <ColorSwatchPicker
              selected={draft.color}
              onSelect={(bg) => setDraft({ ...draft, color: bg })}
            />
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex justify-end gap-1.5 pt-1">
        <Button size="sm" variant="outline" className={COMPACT_BUTTON_CLS} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          className={COMPACT_BUTTON_CLS}
          style={{ background: 'var(--ls-accent)', color: 'white' }}
          onClick={onSave}
          disabled={saveDisabled}
        >
          {mode === 'edit' ? 'Update' : 'Save'}
        </Button>
      </div>
    </div>
  );
};

export const ColorRulesPanel = () => {
  const { colorRules, addRule, updateRule, deleteRule, toggleRule } = useColorRuleStore();
  const { logData } = useLogResultStore();
  const { selectedColumns } = useSearchQueryParamsStore();

  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRule>(blankDraft);

  const availableFields = logData?.logs && logData.logs.length > 0
    ? [...new Set([...selectedColumns, ...Object.keys(logData.logs[0])])]
        .filter((f) => f !== '_raw')
    : selectedColumns;

  const enabledCount = colorRules.filter((r) => r.enabled).length;
  const totalCount = colorRules.length;

  const resetForm = () => {
    setIsAdding(false);
    setEditingId(null);
    setDraft(blankDraft());
  };

  const handleEdit = (rule: ColorRule) => {
    setIsAdding(false);
    setEditingId(rule.id);
    setDraft({
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      color: rule.color,
      enabled: rule.enabled,
    });
  };

  const handleSave = () => {
    if (!draft.field || (draft.operator !== 'exists' && !draft.value)) return;
    const payload: DraftRule = draft.operator === 'exists' ? { ...draft, value: '' } : draft;
    if (editingId) {
      updateRule(editingId, payload);
    } else {
      addRule(payload);
    }
    resetForm();
    triggerColorReapply();
  };

  return (
    <TooltipProvider>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span
            className="text-[10.5px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--ls-text-3)' }}
          >
            Highlight rules
          </span>
          {totalCount > 0 && (
            <span
              className="text-[11px] font-medium"
              style={{ color: 'var(--ls-text-3)' }}
            >
              {enabledCount}/{totalCount} on
            </span>
          )}
        </div>

        <div className="space-y-2">
          {colorRules.map((rule) =>
            editingId === rule.id ? (
              <RuleForm
                key={rule.id}
                draft={draft}
                setDraft={setDraft}
                availableFields={availableFields}
                onSave={handleSave}
                onCancel={resetForm}
                mode="edit"
              />
            ) : (
              <RuleCard
                key={rule.id}
                rule={rule}
                onToggle={() => {
                  toggleRule(rule.id);
                  triggerColorReapply();
                }}
                onDelete={() => {
                  if (editingId === rule.id) resetForm();
                  deleteRule(rule.id);
                  triggerColorReapply();
                }}
                onEdit={() => handleEdit(rule)}
              />
            )
          )}
        </div>

        {isAdding ? (
          <RuleForm
            draft={draft}
            setDraft={setDraft}
            availableFields={availableFields}
            onSave={handleSave}
            onCancel={resetForm}
            mode="add"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setDraft(blankDraft());
              setIsAdding(true);
            }}
            className="w-full flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[11.5px] font-medium transition-colors"
            style={{
              border: '1px dashed var(--ls-border-strong)',
              color: 'var(--ls-text-2)',
              background: 'transparent',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--ls-bg-2)';
              e.currentTarget.style.color = 'var(--ls-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--ls-text-2)';
            }}
          >
            <Plus className="h-3 w-3" />
            Add rule
          </button>
        )}
      </div>
    </TooltipProvider>
  );
};
