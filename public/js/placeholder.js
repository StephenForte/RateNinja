import { heading, paragraph } from './dom.js';

export function mountPlaceholder(container, title, message) {
    container.replaceChildren(heading(title), paragraph('pull-forward-subtitle', message));
}
