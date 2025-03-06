Common GAM commands that I don't use enough to warrant a script

See: https://gamcheatsheet.com/GAM%20Cheat%20Sheet%20A4.pdf

# Groups

Clear all members from a group (ex: at the start of a season):
`gam update group <group email> clear member`

## Templates

Create a template based on an example group:
`gam info group "$groupEmail" noaliases nousers formatjson > "$template_path$"`

Apply a template to a group:
`gam update group "$groupEmail" settings json "$template_path"
