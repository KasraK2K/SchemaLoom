import type { TypeParameterDescriptor, TypePickerOption } from '@schemaloom/engine-sdk/ui';
import type { TypeRef } from '@schemaloom/schema-model';
import { cn } from '@schemaloom/ui';
import type { TypePickerProps } from '@schemaloom/engine-sdk/ui';

const controlClass =
  'h-8 rounded-md border border-border bg-surface px-2 text-sm text-text disabled:opacity-50';

/** Stable across renders and unique: a custom type's id, or a builtin's canonical name. */
const optionKey = (option: TypePickerOption): string =>
  option.customTypeId ?? `builtin:${option.value.name}`;

/** Groups preserve first-seen order, which is the order `listPickerOptions` already sorted. */
function groupOptions(
  options: readonly TypePickerOption[],
): readonly (readonly [string, readonly TypePickerOption[]])[] {
  const groups = new Map<string, TypePickerOption[]>();
  for (const option of options) {
    const bucket = groups.get(option.group);
    if (bucket === undefined) groups.set(option.group, [option]);
    else bucket.push(option);
  }
  return [...groups];
}

/** Positional args line up with the descriptor's parameters — `numeric(10,2)` is
 *  `[precision, scale]`. An arg the user cleared is dropped along with every arg after it,
 *  because `numeric(,2)` is not a thing. */
function buildArgs(
  parameters: readonly TypeParameterDescriptor[],
  raw: readonly (string | number | undefined)[],
): (string | number)[] {
  const args: (string | number)[] = [];
  for (const [i, parameter] of parameters.entries()) {
    const supplied = raw[i];
    if (supplied === undefined || supplied === '') break;
    args.push(parameter.kind === 'number' ? Number(supplied) : String(supplied));
  }
  return args;
}

/** `Array.prototype.with` throws past the end, and an unfilled parameter list is shorter than
 *  the parameter it is being asked to set — `varchar` with no args, then a length typed in. */
function setArg(
  args: readonly (string | number)[],
  index: number,
  next: string,
): readonly (string | number | undefined)[] {
  const out: (string | number | undefined)[] = [...args];
  while (out.length <= index) out.push(undefined);
  out[index] = next;
  return out;
}

function nextRef(option: TypePickerOption, args: (string | number)[], dimensions: number): TypeRef {
  // `option.value` is already canonical (the catalog's `buildRef` made it); only the parts the
  // picker owns are overlaid, so no ref is ever assembled by string concatenation.
  const ref: TypeRef = { ...option.value };
  return {
    ...ref,
    ...(args.length > 0 ? { args } : { args: undefined }),
    ...(dimensions > 0 ? { dimensions } : { dimensions: undefined }),
  };
}

export function MySqlTypePicker({ value, options, resolved, disabled, onChange }: TypePickerProps) {
  const selected = options.find((option) => option.value.name === value.name);
  const parameters = selected?.parameters ?? [];
  const args: readonly (string | number)[] = value.args ?? [];
  const dimensions = value.dimensions ?? 0;

  const emit = (
    option: TypePickerOption | undefined,
    rawArgs: readonly (string | number | undefined)[],
    nextDimensions: number,
  ): void => {
    if (option === undefined) return;
    onChange(nextRef(option, buildArgs(option.parameters, rawArgs), nextDimensions));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={cn(controlClass, 'min-w-40')}
        disabled={disabled}
        value={selected === undefined ? '' : optionKey(selected)}
        onChange={(event) => {
          const picked = options.find((option) => optionKey(option) === event.target.value);
          // Args from the old type mean nothing to the new one; start clean.
          emit(picked, [], dimensions);
        }}
        aria-label={resolved.display}
      >
        {selected === undefined ? <option value="">{value.name}</option> : null}
        {groupOptions(options).map(([group, groupItems]) => (
          <optgroup key={group} label={group}>
            {groupItems.map((option) => (
              <option key={optionKey(option)} value={optionKey(option)}>
                {option.label}
                {option.deprecated ? ' (deprecated)' : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {parameters.map((parameter, index) => (
        <label key={parameter.name} className="flex items-center gap-1 text-xs text-text-muted">
          {parameter.label}
          {parameter.kind === 'enum' ? (
            <select
              className={controlClass}
              disabled={disabled}
              value={String(args[index] ?? parameter.default ?? '')}
              onChange={(event) => {
                emit(selected, setArg(args, index, event.target.value), dimensions);
              }}
            >
              <option value="" />
              {parameter.options.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={cn(controlClass, 'w-20')}
              type={parameter.kind === 'number' ? 'number' : 'text'}
              min={parameter.kind === 'number' ? parameter.min : undefined}
              max={parameter.kind === 'number' ? parameter.max : undefined}
              disabled={disabled}
              value={String(args[index] ?? '')}
              placeholder={parameter.default === null ? '' : String(parameter.default)}
              onChange={(event) => {
                emit(selected, setArg(args, index, event.target.value), dimensions);
              }}
            />
          )}
        </label>
      ))}

      {value.name === 'enum' || value.name === 'set' ? (
        <label className="flex items-center gap-1 text-xs text-text-muted">
          Values
          <input
            className={cn(controlClass, 'min-w-48')}
            disabled={disabled}
            defaultValue={args.join(', ')}
            placeholder="active, closed"
            onBlur={(event) => {
              const values = event.target.value
                .split(',')
                .map((v) => v.trim())
                .filter((v) => v !== '');
              onChange({
                ...value,
                ...(values.length > 0 ? { args: values } : { args: undefined }),
              });
            }}
          />
        </label>
      ) : null}

      {selected?.supportsArray === true ? (
        <label className="flex items-center gap-1 text-xs text-text-muted">
          <input
            type="checkbox"
            disabled={disabled}
            checked={dimensions > 0}
            onChange={(event) => {
              emit(selected, args, event.target.checked ? 1 : 0);
            }}
          />
          Array
        </label>
      ) : null}
    </div>
  );
}
