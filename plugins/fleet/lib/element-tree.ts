import { isValidElement, type ReactElement, type ReactNode } from "react";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

/** Expands hook-free function components so tests can find and drive their elements without a DOM. */
export function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<AnyProps>;
  if (typeof element.type === "function") return expand((element.type as (props: AnyProps) => ReactNode)(element.props));
  const children = element.props.children;
  return children === undefined ? element : { ...element, props: { ...element.props, children: expand(children) } };
}

export function findAll(node: ReactNode, test: (element: ReactElement<AnyProps>) => boolean): ReactElement<AnyProps>[] {
  const found: ReactElement<AnyProps>[] = [];
  const walk = (value: ReactNode) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isValidElement(value)) return;
    const element = value as ReactElement<AnyProps>;
    if (test(element)) found.push(element);
    walk(element.props.children);
  };
  walk(expand(node));
  return found;
}

export function textOf(node: ReactNode): string {
  const expanded = expand(node);
  if (Array.isArray(expanded)) return expanded.map(textOf).join("");
  if (typeof expanded === "string" || typeof expanded === "number") return String(expanded);
  if (!isValidElement(expanded)) return "";
  return textOf((expanded as ReactElement<AnyProps>).props.children);
}
