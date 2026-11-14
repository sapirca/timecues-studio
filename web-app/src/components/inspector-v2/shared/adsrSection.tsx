import type { CardSectionSpec } from './CardSection';
import { AdsrControl, type AdsrControlProps } from './AdsrControl';

export type AdsrSectionProps = AdsrControlProps;

/** Folded "ADSR" section — the item's envelope and its Extract ADSR button.
 *  The one section every card whose item carries an envelope uses (spans,
 *  lyrics). */
export function adsrSection(props: AdsrSectionProps): CardSectionSpec {
  return {
    id: 'adsr',
    title: 'ADSR',
    defaultOpen: true,
    summary: props.extracting ? 'extracting…'
      : props.envelope ? `${props.envelope.source ? `${props.envelope.source} · ` : ''}peak ${props.envelope.peakDb} dBFS` : 'none',
    content: <AdsrControl {...props} />,
  };
}
