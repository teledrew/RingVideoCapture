/**
 * Translates Ring push notifications into recordable events.
 *
 * Kept separate from the main loop so the classification rules can be tested
 * without a Ring account or a live push connection.
 */

const DING_CATEGORY = 'com.ring.pn.live-event.ding';
const MOTION_CATEGORY = 'com.ring.pn.live-event.motion';

const MOTION_SUBTYPES = ['motion', 'other_motion', 'human'];

/**
 * Classifies a push notification.
 *
 * @returns {{kind: 'ding'|'motion', subtype: string, dingId?: string, at: Date}|null}
 *   null when the notification is not a recordable camera event (for example an
 *   alarm-mode change or an intercom unlock).
 */
export const classifyNotification = (notification) => {
  const category = notification?.android_config?.category ?? '';
  const ding = notification?.data?.event?.ding;
  const subtype = ding?.subtype ?? 'unknown';

  let kind = null;
  if (category === DING_CATEGORY) {
    kind = 'ding';
  } else if (category === MOTION_CATEGORY) {
    kind = 'motion';
  } else if (subtype === 'ding') {
    // Fall back to the ding subtype in case Ring changes the category strings.
    kind = 'ding';
  } else if (MOTION_SUBTYPES.includes(subtype)) {
    kind = 'motion';
  }

  if (!kind) {
    return null;
  }

  const createdAt = ding?.created_at ? new Date(ding.created_at) : null;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime());

  return {
    kind,
    subtype,
    dingId: ding?.id,
    // Prefer Ring's own trigger time so filenames match the real event.
    at: validCreatedAt ? createdAt : new Date(),
  };
};
