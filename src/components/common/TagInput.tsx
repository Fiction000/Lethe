import React, { useState, useEffect, useRef } from 'react';
import { App } from 'obsidian';
import '../../less/tag-input.less';

interface TagInputProps {
  app: App;
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  placeholder?: string;
}

export const TagInput: React.FC<TagInputProps> = ({
  app,
  selectedTags,
  onTagsChange,
  placeholder = 'Add tags...',
}) => {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Get all tags from vault
  const getAllVaultTags = (): string[] => {
    const allTags = new Set<string>();
    const metadataCache = app.metadataCache;

    // Get all files in vault
    const files = app.vault.getMarkdownFiles();

    files.forEach((file) => {
      const cache = metadataCache.getFileCache(file);
      if (cache?.tags) {
        cache.tags.forEach((tag) => {
          // Remove leading # if present
          const tagName = tag.tag.startsWith('#') ? tag.tag.slice(1) : tag.tag;
          allTags.add(tagName);
        });
      }

      // Also check frontmatter tags
      if (cache?.frontmatter?.tags) {
        const fmTags = cache.frontmatter.tags;
        if (Array.isArray(fmTags)) {
          fmTags.forEach((tag) => {
            const tagName = typeof tag === 'string' ? tag : String(tag);
            allTags.add(tagName.replace(/^#/, ''));
          });
        }
      }
    });

    return Array.from(allTags).sort();
  };

  // Filter suggestions based on input
  useEffect(() => {
    if (inputValue.trim()) {
      const allTags = getAllVaultTags();
      const filtered = allTags
        .filter((tag) =>
          tag.toLowerCase().includes(inputValue.toLowerCase()) &&
          !selectedTags.includes(tag)
        )
        .slice(0, 10); // Limit to 10 suggestions

      setSuggestions(filtered);
      setShowSuggestions(filtered.length > 0);
      setActiveSuggestionIndex(0);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }, [inputValue, selectedTags]);

  const addTag = (tag: string) => {
    const cleanTag = tag.trim().replace(/^#/, '');
    if (cleanTag && !selectedTags.includes(cleanTag)) {
      onTagsChange([...selectedTags, cleanTag]);
      setInputValue('');
      setShowSuggestions(false);
      inputRef.current?.focus();
    }
  };

  const removeTag = (tagToRemove: string) => {
    onTagsChange(selectedTags.filter((tag) => tag !== tagToRemove));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showSuggestions && suggestions.length > 0) {
        // Add the active suggestion
        addTag(suggestions[activeSuggestionIndex]);
      } else if (inputValue.trim()) {
        // Add the typed value as a new tag
        addTag(inputValue);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (showSuggestions) {
        setActiveSuggestionIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (showSuggestions) {
        setActiveSuggestionIndex((prev) => (prev > 0 ? prev - 1 : 0));
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    } else if (e.key === 'Backspace' && !inputValue && selectedTags.length > 0) {
      // Remove last tag when backspace on empty input
      removeTag(selectedTags[selectedTags.length - 1]);
    }
  };

  const handleSuggestionClick = (tag: string) => {
    addTag(tag);
  };

  return (
    <div className="tag-input-container">
      <div className="tag-input-wrapper">
        <div className="selected-tags">
          {selectedTags.map((tag) => (
            <span key={tag} className="tag-chip">
              #{tag}
              <button
                type="button"
                className="tag-remove"
                onClick={() => removeTag(tag)}
                aria-label={`Remove tag ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleInputKeyDown}
          placeholder={selectedTags.length === 0 ? placeholder : ''}
          className="tag-input-field"
        />
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div ref={suggestionsRef} className="tag-suggestions">
          {suggestions.map((tag, index) => (
            <div
              key={tag}
              className={`tag-suggestion ${index === activeSuggestionIndex ? 'active' : ''}`}
              onClick={() => handleSuggestionClick(tag)}
              onMouseEnter={() => setActiveSuggestionIndex(index)}
            >
              #{tag}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
