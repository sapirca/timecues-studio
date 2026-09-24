/**
 * Where an energy export can be saved, and which destination the picker opens
 * on. Its own module rather than part of EnergySpanExportPopover so both the
 * popover and the page that materializes the chosen lane can import it (and
 * so the component file keeps exporting only components).
 */

/** Sentinel destination ids. Picking one means "create the lane on save" —
 *  the layer is only materialized by the caller once Save is pressed, so
 *  cancelling the popover leaves nothing behind. There are two because they
 *  name the lane they create differently: the energies one always writes
 *  ENERGY_SPAN_LAYER_NAME, the plain one keeps the generic "Spans N". */
export const NEW_ENERGY_SPAN_LAYER_ID = '__new_energy_span_layer__';
export const NEW_SPAN_LAYER_ID = '__new_span_layer__';

/** The lane energy exports belong in. Kept as one dedicated lane per song so
 *  a consumer (the LOL light-show agent) can read the lane wholesale instead
 *  of sifting energy items out of a lane holding hand-drawn spans too. */
export const ENERGY_SPAN_LAYER_NAME = 'energies';

export interface EnergySpanLayerOption { id: string; name: string; color: string }

/**
 * Destinations for the "Save into" picker, energies lane first — so the
 * preselected one is always the energy lane and the first export of a song
 * needs no pick at all. That head entry is the song's existing "energies"
 * lane when it has one, and otherwise the sentinel that creates it. The
 * song's other span lanes follow (an energy span is an ordinary span item;
 * nothing stops the user filing it elsewhere), then "+ New Span Layer".
 *
 * A song with no span lane at all gets the single energies option: there is
 * nothing to add to yet, and "+ New Span Layer" would only be a second way
 * to say the same thing.
 */
export function buildEnergySpanLayerOptions(
  spanLayers: EnergySpanLayerOption[],
  newLayerColor: string,
): EnergySpanLayerOption[] {
  const energyLayer = spanLayers.find((l) => l.name === ENERGY_SPAN_LAYER_NAME);
  const head: EnergySpanLayerOption = energyLayer
    ? { id: energyLayer.id, name: energyLayer.name, color: energyLayer.color }
    : { id: NEW_ENERGY_SPAN_LAYER_ID, name: ENERGY_SPAN_LAYER_NAME, color: newLayerColor };
  const rest = spanLayers
    .filter((l) => l.id !== energyLayer?.id)
    .map((l) => ({ id: l.id, name: l.name, color: l.color }));
  return [
    head,
    ...rest,
    ...(spanLayers.length
      ? [{ id: NEW_SPAN_LAYER_ID, name: '+ New Span Layer', color: '#38bdf8' }]
      : []),
  ];
}

