/**
 * aspColouringWorker.ts
 *
 * The worker thread for the VBScript and SQL colouring and the SQL warnings
 * (vbscript/aspColouring.ts does the work).
 */

import { colourAspPage, type AspColouringRequest, type AspColouringResult } from '../vbscript/aspColouring';
import { serveWorker } from './serveWorker';

// A half-typed page that trips a pass must cost this one refresh of the
// colours, not the worker. The tokens are handed over, not copied: on a large
// page they run to hundreds of thousands of numbers.
serveWorker<AspColouringRequest, AspColouringResult>(
    colourAspPage,
    request => ({ id: request.id, tokens: new Uint32Array(), warnings: [] }),
    answer => [answer.tokens.buffer as ArrayBuffer],
);
