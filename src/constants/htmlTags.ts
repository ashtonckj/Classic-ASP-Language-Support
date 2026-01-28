// Common HTML tags with descriptions
export const HTML_TAGS = [
    // Document structure
    { tag: 'html', description: 'HTML root element' },
    { tag: 'head', description: 'Document head' },
    { tag: 'body', description: 'Document body' },
    { tag: 'title', description: 'Document title' },
    { tag: 'meta', description: 'Metadata', selfClosing: true },
    { tag: 'link', description: 'External resource link', selfClosing: true },
    { tag: 'style', description: 'CSS styles' },
    { tag: 'script', description: 'JavaScript code' },
    { tag: 'base', description: 'Base URL', selfClosing: true },
    
    // Sections
    { tag: 'header', description: 'Header section' },
    { tag: 'footer', description: 'Footer section' },
    { tag: 'nav', description: 'Navigation section' },
    { tag: 'main', description: 'Main content' },
    { tag: 'section', description: 'Section of content' },
    { tag: 'article', description: 'Article content' },
    { tag: 'aside', description: 'Sidebar content' },
    { tag: 'address', description: 'Contact information' },
    
    // Content containers
    { tag: 'div', description: 'Generic container element' },
    { tag: 'span', description: 'Inline container element' },
    { tag: 'p', description: 'Paragraph' },
    { tag: 'pre', description: 'Preformatted text' },
    { tag: 'blockquote', description: 'Block quotation' },
    { tag: 'figure', description: 'Figure with caption' },
    { tag: 'figcaption', description: 'Figure caption' },
    { tag: 'details', description: 'Disclosure widget' },
    { tag: 'summary', description: 'Summary for details' },
    { tag: 'dialog', description: 'Dialog box' },
    
    // Headings
    { tag: 'h1', description: 'Heading level 1' },
    { tag: 'h2', description: 'Heading level 2' },
    { tag: 'h3', description: 'Heading level 3' },
    { tag: 'h4', description: 'Heading level 4' },
    { tag: 'h5', description: 'Heading level 5' },
    { tag: 'h6', description: 'Heading level 6' },
    { tag: 'hgroup', description: 'Heading group' },
    
    // Links and media
    { tag: 'a', description: 'Hyperlink' },
    { tag: 'img', description: 'Image', selfClosing: true },
    { tag: 'video', description: 'Video player' },
    { tag: 'audio', description: 'Audio player' },
    { tag: 'source', description: 'Media source', selfClosing: true },
    { tag: 'track', description: 'Text track', selfClosing: true },
    { tag: 'picture', description: 'Picture element' },
    { tag: 'iframe', description: 'Inline frame' },
    { tag: 'embed', description: 'Embedded content', selfClosing: true },
    { tag: 'object', description: 'Embedded object' },
    { tag: 'param', description: 'Object parameter', selfClosing: true },
    
    // Lists
    { tag: 'ul', description: 'Unordered list' },
    { tag: 'ol', description: 'Ordered list' },
    { tag: 'li', description: 'List item' },
    { tag: 'dl', description: 'Description list' },
    { tag: 'dt', description: 'Description term' },
    { tag: 'dd', description: 'Description details' },
    { tag: 'menu', description: 'Menu list' },
    
    // Tables
    { tag: 'table', description: 'Table' },
    { tag: 'thead', description: 'Table header group' },
    { tag: 'tbody', description: 'Table body group' },
    { tag: 'tfoot', description: 'Table footer group' },
    { tag: 'tr', description: 'Table row' },
    { tag: 'td', description: 'Table data cell' },
    { tag: 'th', description: 'Table header cell' },
    { tag: 'caption', description: 'Table caption' },
    { tag: 'col', description: 'Table column', selfClosing: true },
    { tag: 'colgroup', description: 'Table column group' },
    
    // Forms
    { tag: 'form', description: 'Form element' },
    { tag: 'input', description: 'Input field', selfClosing: true },
    { tag: 'textarea', description: 'Multi-line text input' },
    { tag: 'button', description: 'Button element' },
    { tag: 'select', description: 'Dropdown select' },
    { tag: 'option', description: 'Option in select' },
    { tag: 'optgroup', description: 'Option group' },
    { tag: 'label', description: 'Label for form element' },
    { tag: 'fieldset', description: 'Group form elements' },
    { tag: 'legend', description: 'Fieldset caption' },
    { tag: 'datalist', description: 'Autocomplete options' },
    { tag: 'output', description: 'Calculation result' },
    { tag: 'progress', description: 'Progress indicator' },
    { tag: 'meter', description: 'Scalar measurement' },
    
    // Text formatting
    { tag: 'strong', description: 'Strong emphasis (bold)' },
    { tag: 'em', description: 'Emphasis (italic)' },
    { tag: 'b', description: 'Bold text' },
    { tag: 'i', description: 'Italic text' },
    { tag: 'u', description: 'Underlined text' },
    { tag: 's', description: 'Strikethrough text' },
    { tag: 'mark', description: 'Highlighted text' },
    { tag: 'small', description: 'Smaller text' },
    { tag: 'del', description: 'Deleted text' },
    { tag: 'ins', description: 'Inserted text' },
    { tag: 'sub', description: 'Subscript' },
    { tag: 'sup', description: 'Superscript' },
    { tag: 'code', description: 'Code snippet' },
    { tag: 'kbd', description: 'Keyboard input' },
    { tag: 'samp', description: 'Sample output' },
    { tag: 'var', description: 'Variable' },
    { tag: 'q', description: 'Inline quotation' },
    { tag: 'cite', description: 'Citation' },
    { tag: 'abbr', description: 'Abbreviation' },
    { tag: 'dfn', description: 'Definition' },
    { tag: 'time', description: 'Date/time' },
    { tag: 'data', description: 'Machine-readable data' },
    { tag: 'bdi', description: 'Bi-directional isolate' },
    { tag: 'bdo', description: 'Bi-directional override' },
    { tag: 'wbr', description: 'Word break opportunity', selfClosing: true },
    
    // Breaks and separators
    { tag: 'br', description: 'Line break', selfClosing: true },
    { tag: 'hr', description: 'Horizontal rule', selfClosing: true },
    
    // Graphics
    { tag: 'canvas', description: 'Canvas for graphics' },
    { tag: 'svg', description: 'Scalable vector graphics' },
    { tag: 'map', description: 'Image map' },
    { tag: 'area', description: 'Image map area', selfClosing: true },
    
    // Ruby annotations
    { tag: 'ruby', description: 'Ruby annotation' },
    { tag: 'rt', description: 'Ruby text' },
    { tag: 'rp', description: 'Ruby parenthesis' },
    
    // Templates
    { tag: 'template', description: 'Template element' },
    { tag: 'slot', description: 'Web component slot' },
    { tag: 'noscript', description: 'No script fallback' },
];

// Check if a tag is self-closing
export function isSelfClosingTag(tagName: string): boolean {
    const tag = HTML_TAGS.find(t => t.tag.toLowerCase() === tagName.toLowerCase());
    return tag?.selfClosing === true;
}