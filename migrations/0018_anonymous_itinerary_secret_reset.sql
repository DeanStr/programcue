-- Anonymous itinerary lookup hashes created with the former authentication
-- secret cannot be derived with the new dedicated secret. This explicit
-- pre-release reset removes those unreachable rows instead of retaining stale
-- data or adding an authentication-secret compatibility fallback. New hashes
-- carry the v2 scheme prefix, making the cleanup safe on either side of the
-- Worker deployment. Signed-in and newly created v2 itineraries are unaffected.
DELETE FROM public_itineraries
 WHERE person_id IS NULL
   AND visitor_key_hash NOT LIKE 'v2.%';
