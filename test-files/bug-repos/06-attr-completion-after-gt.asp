<%@ LANGUAGE="VBSCRIPT" %>
<!--
  HTML attribute IntelliSense finds "am I inside a tag?" with a naive
  lastIndexOf('<') vs lastIndexOf('>') over the text before the caret. A ">"
  inside a quoted attribute value counts as the tag's end, so attribute
  suggestions stop for the rest of that tag.

  WHAT TO LOOK FOR
    In each line below, put the caret at the marked spot (after the trailing
    space, before the ">") and press Ctrl+Space.

    Line 22  <a title="a > b" |>            -> no attribute list      (broken)
    Line 23  <div onclick="if(a>b)go()" |>  -> no attribute list      (broken)
    Line 26  <a title="a b" |>              -> href/target/rel/...    (control)
    Line 27  <input value="<%= x %>" |>     -> value/name/type/...    (control,
             ASP blocks ARE handled correctly — only literal ">" breaks it)
-->
<html>
<body>

<a title="a > b" ></a>
<div onclick="if(a>b)go()" ></div>

<a title="a b" ></a>
<input value="<%= x %>" />

</body>
</html>
