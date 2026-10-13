import { sections } from './registry.js';

export function menuFor(permissions) {
    return sections
        .filter(section => section.allow(permissions))
        .map(section => ({
            id: section.id,
            label: section.label,
            path: section.path,
            group: section.group
        }));
}
