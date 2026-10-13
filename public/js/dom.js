export function textCell(value, tagName = 'td', className = '') {
    const cell = document.createElement(tagName);
    cell.textContent = value ?? '';
    if (className) cell.className = className;
    return cell;
}

export function heading(text) {
    const node = document.createElement('h2');
    node.textContent = text;
    return node;
}

export function paragraph(className, text) {
    const node = document.createElement('p');
    if (className) node.className = className;
    node.textContent = text;
    return node;
}

export function errorBox(className = 'error') {
    const box = document.createElement('div');
    box.className = className;
    box.hidden = true;
    const icon = document.createElement('i');
    icon.className = 'fas fa-exclamation-triangle';
    icon.setAttribute('aria-hidden', 'true');
    const message = document.createElement('span');
    box.append(icon, message);
    return {
        box,
        show(text) {
            message.textContent = text;
            box.hidden = false;
        },
        hide() {
            box.hidden = true;
        }
    };
}

export function fieldLabel(text, control) {
    const label = document.createElement('label');
    label.append(document.createTextNode(text), control);
    return label;
}
