import { defineSearchAttributeKey, SearchAttributeType } from "@temporalio/common";

/** Register these in the namespace. The dev server takes them as --search-attribute flags. */
export const SOURCE_ORDER_NUMBER = defineSearchAttributeKey("SourceOrderNumber", SearchAttributeType.KEYWORD);
export const DELIVERY_STAGE = defineSearchAttributeKey("DeliveryStage", SearchAttributeType.KEYWORD);
export const DELIVERY_OVERDUE = defineSearchAttributeKey("DeliveryOverdue", SearchAttributeType.BOOL);
