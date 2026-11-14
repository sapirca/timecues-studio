import type { CardSectionSpec } from './CardSection';
import { ItemColorControl, type ItemColorControlProps } from './ItemColorControl';

/** Folded "Colour" section — its summary is the item's colour, or the name
 *  of what it falls back to. */
export function colorSection(props: ItemColorControlProps): CardSectionSpec {
  return {
    id: 'item-colour',
    title: 'Colour',
    defaultOpen: false,
    summary: props.color ?? props.fallbackName ?? 'layer colour',
    content: <ItemColorControl {...props} />,
  };
}
